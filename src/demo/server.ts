import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'
import { decide } from '../buyer/decide.js'
import { McpClient } from '../hsp/mcpClient.js'
import { mockAbsent, mockAsset, selectMockAsset, startMock, type MockOptions } from '../hsp/mockServer.js'
import type { Asset, Payment, Protocol, TypedMessage } from '../hsp/types.js'
import { PayOnce, type Approval, type Clock, type Entry } from '../payOnce.js'
import { createPayOnceApi, type PayOnceApiHandle } from '../payOnceApi.js'
import { createSellerServer, type VerifyPayment } from '../seller/server.js'
import { Store } from '../store.js'
import type { PayIntent, PaymentTerms } from '../types.js'

// A single local door for the demo. Everything runs on 127.0.0.1. The HSP is the local mock unless a
// URL is configured; with a URL, only configuration changes (this module never decides to go online).

export type ApprovalStage = 'sign' | 'submit'
export type FaultKind = 'drop-after-submit' | 'expire-quote'

export interface ApprovalInfo {
  approvalId: string
  requestId: Hex
  stage: ApprovalStage
  review: Approval
  /** The buyer's decision text, shown on the approval screen. */
  text?: string
}

export interface DemoOptions {
  /** 0 picks a free port. */
  port?: number
  /** Default: a fresh temporary directory that is removed on close(). */
  journalDir?: string
  /** Unset = local mock HSP. Set = this MCP URL (an asset must be given too). */
  hspUrl?: string
  /** Required for any host that is not loopback. */
  allowExternalHsp?: boolean
  /** The network/token to pay in when hspUrl is set (the mock supplies its own). */
  asset?: Asset
  protocol?: Protocol
  /** Query answers of the mock HSP, in order (the last one repeats). */
  statuses?: Payment[]
  /** Default: an in-memory key made at start-up. It is never written or logged. */
  account?: { address: Address; signTypedData(message: TypedMessage): Promise<Hex> }
  payTo?: Address
  buyerAgentId?: string
  /** Called after an approval is registered. Tests press the button through this hook. */
  onApprovalRequested?(info: ApprovalInfo): void | Promise<void>
}

export interface DemoServer {
  /** Base URL of the demo door, e.g. http://127.0.0.1:3100 */
  url: string
  sellerUrl: string
  hspUrl: string
  mode: 'mock' | 'external'
  /** Present only in mock mode: the mock HSP's own count of what it received. */
  audit?: Awaited<ReturnType<typeof startMock>>['audit']
  buyer: Address
  close(): Promise<void>
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const crashed = () => new Error('simulated crash')

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/)
const termsSchema = z.object({
  sellerAgentId: z.string().min(1), payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/), amountUsd: z.string(),
  item: z.string(), itemVersionHash: hex, expiresAt: z.string(), whatYouLearn: z.string(),
})
const quoteBody = z.object({
  requiredFields: z.array(z.string()).optional(),
  local: z.record(z.string(), z.unknown()).optional(),
  intentNonce: z.string().trim().min(1).optional(),
}).strict()
const approveBody = z.object({
  requestId: z.string().regex(/^0x[0-9a-f]{64}$/),
  stage: z.enum(['sign', 'submit']),
  approve: z.boolean(),
  approvalId: z.string().optional(),
}).strict()
const faultBody = z.object({ kind: z.enum(['drop-after-submit', 'expire-quote']) }).strict()
const deliverBody = z.object({ requestId: z.string().regex(/^0x[0-9a-f]{64}$/) }).strict()

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(crashed())
    const onAbort = () => { clearTimeout(timer); reject(crashed()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function listen(server: Server, port: number) {
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}
async function shut(server: Server) {
  const closed = once(server, 'close')
  server.close()
  server.closeAllConnections()
  await closed
}

const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url))
const WEB_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
}

interface Engine {
  generation: number
  aborted: boolean
  signal: AbortSignal
  hsp: McpClient
  api: PayOnceApiHandle
  abort(): Promise<void>
}
interface RequestInfo {
  requestId: Hex
  terms: PaymentTerms
  approvalText: string
  intentNonce: string
  createdAt: string
  lastError?: string
}
interface Pending {
  info: ApprovalInfo
  engine: Engine
  resolve(approved: boolean): void
  reject(error: Error): void
}

export async function createDemoServer(options: DemoOptions = {}): Promise<DemoServer> {
  const external = options.hspUrl !== undefined
  if (external) {
    const url = new URL(options.hspUrl!)
    if (!loopback.has(url.hostname) && options.allowExternalHsp !== true) {
      throw new Error('Refusing a non-loopback HSP URL without allowExternalHsp')
    }
    const a = options.asset
    if (!a || !a.network?.trim() || !a.coin?.trim() || !Number.isSafeInteger(a.chain_id) || a.chain_id <= 0 ||
        !isAddress(a.contract_address)) {
      throw new Error('A valid asset (network, chain_id, contract_address, coin) is required with hspUrl')
    }
  }
  const protocol: Protocol = options.protocol ?? 'eip3009'
  const account = options.account ?? privateKeyToAccount(generatePrivateKey())
  const buyerAgentId = options.buyerAgentId ?? 'Research Agent'
  // Default seller address: made at each start-up from a throw-away key. Only the address is kept; the key is dropped.
  const payTo = getAddress(options.payTo ?? privateKeyToAccount(generatePrivateKey()).address)

  const mockOptions: MockOptions = { statuses: options.statuses }
  const mock = external ? undefined : await startMock(mockOptions)
  const hspUrl = mock ? mock.url : options.hspUrl!
  const asset = options.asset ?? mockAsset
  const ownJournal = options.journalDir === undefined
  const journalDir = options.journalDir ?? await mkdtemp(join(tmpdir(), 'once-demo-'))

  // --- the seller (A2A JSON-RPC). It checks payment with the HSP itself, not with our records. ---
  const verifyPayment: VerifyPayment = async claim => {
    const client = await McpClient.connect({ url: hspUrl, ipv4Only: true })
    try {
      const payment = await client.call('query_payment', {
        flow_id: claim.flowId, expected_merchant_name: claim.expected.sellerAgentId,
      })
      return payment.status === 'payment-safe' || payment.status === 'payment-finalized'
    } catch { return false } finally { await client.close() }
  }
  const sellerServer = createSellerServer({ payTo, verifyPayment })
  const sellerUrl = `http://127.0.0.1:${await listen(sellerServer, 0)}`

  async function a2a(data: object): Promise<unknown> {
    const response = await fetch(sellerUrl + '/a2a', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: randomUUID(), method: 'message/send',
        params: { message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data', data }] } },
      }),
    })
    const body = await response.json() as { result?: { parts?: { data?: unknown }[] }; error?: { code: number; message: string } }
    if (body.error) throw new HttpError(body.error.code === -32001 ? 402 : 502, `seller: ${body.error.message}`)
    const data0 = body.result?.parts?.[0]?.data
    if (data0 === undefined) throw new HttpError(502, 'seller: empty reply')
    return data0
  }

  // --- events (Server-Sent Events) ---
  const listeners = new Set<ServerResponse>()
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${json(data)}\n\n`
  // Keep the recent events so a reloaded page can still show
  // "connection lost (simulated)" and "resumed: query only" without having been connected.
  const timeline: { event: string; at: string; data: unknown }[] = []
  function emit(event: string, data: unknown) {
    timeline.push({ event, at: new Date().toISOString(), data })
    if (timeline.length > 200) timeline.splice(0, timeline.length - 200)
    for (const res of listeners) { try { res.write(frame(event, data)) } catch { listeners.delete(res) } }
  }

  // --- requests, approvals ---
  const requests = new Map<Hex, RequestInfo>()
  const pending = new Map<Hex, Pending>()
  const waiters = new Map<Hex, Set<() => void>>()
  let approvalSeq = 0
  let generation = 0

  const summary = (info: ApprovalInfo) => ({ approvalId: info.approvalId, requestId: info.requestId, stage: info.stage })

  function requestApproval(engine: Engine, stage: ApprovalStage, review: Approval): Promise<boolean> {
    if (engine.aborted) return Promise.reject(crashed())
    const id = review.requestId
    const info: ApprovalInfo = {
      approvalId: String(++approvalSeq), requestId: id, stage, review, text: requests.get(id)?.approvalText,
    }
    return new Promise<boolean>((resolve, reject) => {
      pending.set(id, { info, engine, resolve, reject })
      emit('approval', { ...summary(info), status: 'requested' })
      for (const wake of waiters.get(id) ?? []) wake()
      const hook = options.onApprovalRequested
      if (hook) void Promise.resolve().then(() => hook(info)).catch(() => { /* a failing test hook leaves the button unpressed */ })
    })
  }
  function whenPending(id: Hex, signal: AbortSignal) {
    return new Promise<void>(resolve => {
      if (pending.has(id)) return resolve()
      const set = waiters.get(id) ?? new Set<() => void>()
      waiters.set(id, set)
      const wake = () => { set.delete(wake); resolve() }
      set.add(wake)
      signal.addEventListener('abort', () => set.delete(wake), { once: true })
    })
  }

  // --- the paying side ("the process"). restart() throws one away and builds the next. ---
  async function makeEngine(): Promise<Engine> {
    const controller = new AbortController()
    const hsp = await McpClient.connect({ url: hspUrl, ipv4Only: true })
    const engine = { generation: ++generation, aborted: false, signal: controller.signal, hsp } as Engine
    try {
      const store = await Store.open<Entry>(journalDir)
      const clock: Clock = { now: Date.now, sleep: ms => abortableSleep(ms, controller.signal) }
      const pay = new PayOnce({
        hsp, store, clock,
        selectAsset: mock ? selectMockAsset : () => asset,
        isDefinitivelyAbsent: mock ? mockAbsent : undefined,
        approveSign: review => requestApproval(engine, 'sign', review),
        approveSubmit: review => requestApproval(engine, 'submit', review),
        async signTypedData(typed) {
          if (engine.aborted) throw crashed()
          return account.signTypedData(typed)
        },
        afterRecord(entry) {
          const info = requests.get(entry.requestId)
          if (info) delete info.lastError
          emit('state', { requestId: entry.requestId, state: entry.step.state, at: new Date(entry.at).toISOString() })
          if (engine.aborted) throw crashed() // a dead process writes nothing more
        },
      })
      engine.api = createPayOnceApi({
        pay, store, network: asset.network, token: asset.contract_address, protocol,
        resolveBuyer: () => account.address,
        awaitingHuman: whenPending,
        onError(id, error) {
          if (engine.aborted) return
          const info = requests.get(id)
          if (info) info.lastError = message(error)
          emit('run-error', { requestId: id, message: message(error) })
        },
      })
      engine.abort = async () => {
        engine.aborted = true
        controller.abort()
        for (const [id, p] of [...pending]) {
          if (p.engine !== engine) continue
          pending.delete(id)
          p.reject(crashed())
          emit('approval', { ...summary(p.info), status: 'cancelled' })
        }
        await engine.hsp.close().catch(() => undefined)
        const stopped = await Promise.race([
          engine.api.idle().then(() => true),
          new Promise<boolean>(resolve => setTimeout(resolve, 10_000, false).unref()),
        ])
        if (!stopped) throw new Error('The old run did not stop')
      }
      return engine
    } catch (error) {
      await hsp.close().catch(() => undefined)
      throw error
    }
  }
  let engine = await makeEngine()

  let restarting: Promise<unknown> | undefined
  async function restart() {
    if (restarting) { await restarting; throw new HttpError(409, 'A restart was already running') }
    const work = (async () => {
      emit('restart', { phase: 'crashing', generation: engine.generation })
      await engine.abort()
      engine = await makeEngine()
      emit('restart', { phase: 'resuming', generation: engine.generation })
      // Returns when every unfinished request is done or waits for a human.
      const records = await engine.api.resumeAll()
      emit('restart', { phase: 'resumed', generation: engine.generation })
      return records
    })()
    restarting = work.catch(() => undefined).finally(() => { restarting = undefined })
    return work
  }

  // --- state ---
  const faults = () => mock ? {
    'drop-after-submit': mockOptions.dropSubmitResponseOnce === true,
    'expire-quote': mockOptions.rejectExpiredOnce === true,
  } : null
  async function snapshot() {
    const list = []
    for (const info of requests.values()) {
      const record = await engine.api.get(info.requestId)
      const waiting = pending.get(info.requestId)
      list.push({
        requestId: info.requestId, item: info.terms.item, amountUsd: info.terms.amountUsd,
        payTo: info.terms.payTo, whatYouLearn: info.terms.whatYouLearn,
        sellerAgentId: info.terms.sellerAgentId, createdAt: info.createdAt,
        state: record?.state ?? 'NEW', flowId: record?.flowId ?? null, txHash: record?.txHash ?? null,
        recordedSubmitAttempts: record?.submitCalls ?? 0, history: record?.history ?? [],
        running: engine.api.isRunning(info.requestId),
        awaitingApproval: waiting ? {
          approvalId: waiting.info.approvalId, stage: waiting.info.stage, text: info.approvalText, review: waiting.info.review,
        } : null,
        error: info.lastError ?? null,
      })
    }
    return {
      mode: mock ? 'mock' : 'external', generation: engine.generation, buyerAgentId, buyer: account.address,
      requests: list,
      timeline,
      // The HSP's own count (mock only): real submit_payment calls, accepted payments, orders.
      hsp: mock ? {
        submitPaymentCalls: mock.audit.submitCalls, accepted: mock.audit.accepted, orders: mock.audit.orderCount,
      } : null,
      faults: faults(),
    }
  }

  // --- the HTTP door ---
  async function body(req: IncomingMessage): Promise<unknown> {
    const type = req.headers['content-type'] ?? ''
    if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'Content-Type must be application/json')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of req) {
      length += (chunk as Buffer).length
      if (length > 64 * 1024) throw new HttpError(413, 'Request too large')
      chunks.push(chunk as Buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.trim()) return {}
    try { return JSON.parse(text) } catch { throw new HttpError(400, 'Invalid JSON') }
  }
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new HttpError(400, 'Invalid request: ' + result.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; '))
    return result.data
  }

  async function route(req: IncomingMessage, res: ServerResponse, port: number) {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
    if (!hosts.includes(req.headers.host ?? '')) throw new HttpError(403, 'Forbidden host')
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) {
      throw new HttpError(403, 'Cross-origin requests are not accepted')
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const key = `${req.method} ${path}`
    // Serve the screen (web/) from the same origin. Fixed list only (no path joins from the URL).
    const page = req.method === 'GET' ? WEB_FILES[path] : undefined
    if (page) {
      const bytes = await readFile(join(WEB_DIR, page.file))
      res.writeHead(200, { 'content-type': page.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(bytes)
      return
    }
    if (restarting && key !== 'GET /api/events') await restarting.catch(() => undefined)

    switch (key) {
      case 'POST /api/quote': {
        const input = parse(quoteBody, await body(req))
        const terms = parse(termsSchema, await a2a({ action: 'quote', item: 'HSKSwap 1h flow report' })) as PaymentTerms
        const required = input.requiredFields ?? terms.whatYouLearn.split(/[,、]/u).map(s => s.trim()).filter(Boolean)
        const decision = decide(required, input.local ?? {}, terms, Date.now())
        if (decision.action === 'skip') { send(res, 200, { decision, terms }); return }
        const intent: PayIntent = { buyerAgentId, terms, intentNonce: input.intentNonce ?? randomUUID() }
        const id = engine.api.requestIdOf(intent)
        requests.set(id, requests.get(id) ?? {
          requestId: id, terms, approvalText: decision.approvalText, intentNonce: intent.intentNonce,
          createdAt: new Date().toISOString(),
        })
        emit('quote', { requestId: id, item: terms.item, amountUsd: terms.amountUsd })
        try {
          // The payment starts here but stops at the first approval: nothing is signed or sent until a human presses.
          const record = await engine.api.payOnce(intent)
          send(res, 200, { decision, terms, approvalText: decision.approvalText, requestId: id, record })
        } catch (error) {
          const info = requests.get(id)
          if (info) info.lastError = message(error)
          send(res, 502, { error: message(error), requestId: id, decision, terms })
        }
        return
      }
      case 'POST /api/approve': {
        const input = parse(approveBody, await body(req))
        const waiting = pending.get(input.requestId as Hex)
        if (!waiting) throw new HttpError(409, 'Nothing is waiting for approval on this request')
        if (waiting.info.stage !== input.stage) throw new HttpError(409, `The request is waiting for the "${waiting.info.stage}" approval`)
        if (input.approvalId !== undefined && input.approvalId !== waiting.info.approvalId) {
          throw new HttpError(409, 'That approval screen is out of date (the quote was renewed)')
        }
        pending.delete(input.requestId as Hex)
        waiting.resolve(input.approve)
        emit('approval', { ...summary(waiting.info), status: input.approve ? 'approved' : 'declined' })
        send(res, 200, { ok: true, ...summary(waiting.info), approved: input.approve })
        return
      }
      case 'POST /api/fault': {
        const input = parse(faultBody, await body(req))
        if (!mock) throw new HttpError(409, 'Faults can only be injected into the local mock HSP')
        if (input.kind === 'drop-after-submit') mockOptions.dropSubmitResponseOnce = true
        else mockOptions.rejectExpiredOnce = true
        emit('fault', { kind: input.kind, armed: true })
        send(res, 200, { ok: true, armed: faults() })
        return
      }
      case 'POST /api/restart': {
        await body(req)
        const records = await restart()
        send(res, 200, { ok: true, generation: engine.generation, resumed: records.map(r => ({ requestId: r.requestId, state: r.state })) })
        return
      }
      case 'POST /api/deliver': {
        const input = parse(deliverBody, await body(req))
        const record = await engine.api.get(input.requestId as Hex)
        if (!record?.flowId) throw new HttpError(404, 'Unknown request or no order yet')
        send(res, 200, { report: await a2a({ action: 'paid', buyerAgentId, flowId: record.flowId }) })
        return
      }
      case 'GET /api/state': send(res, 200, await snapshot()); return
      case 'GET /api/events': {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive',
        })
        res.write(frame('snapshot', await snapshot()))
        listeners.add(res)
        const beat = setInterval(() => { try { res.write(': keep-alive\n\n') } catch { /* closed */ } }, 15_000)
        res.once('close', () => { clearInterval(beat); listeners.delete(res) })
        return
      }
      default: throw new HttpError(404, 'Not found')
    }
  }

  function send(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(json(value))
  }

  const http = createServer((req, res) => {
    route(req, res, (req.socket.localPort ?? 0)).catch(error => {
      if (res.headersSent) { res.end(); return }
      if (error instanceof HttpError) send(res, error.status, { error: error.message })
      else send(res, 500, { error: message(error) })
    })
  })
  const port = await listen(http, options.port ?? 0)

  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${port}`, sellerUrl, hspUrl, mode: mock ? 'mock' : 'external', audit: mock?.audit,
    buyer: account.address,
    close() {
      closing ??= (async () => {
        for (const res of listeners) res.end()
        listeners.clear()
        await engine.abort().catch(() => undefined)
        await shut(http)
        await shut(sellerServer)
        await mock?.close()
        if (ownJournal) await rm(journalDir, { recursive: true, force: true })
      })()
      return closing
    },
  }
}

function json(value: unknown) {
  return JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v)
}

// ---- run as a program: `npm run demo:server` ----
function config(env: NodeJS.ProcessEnv): DemoOptions & { port: number } {
  const options: DemoOptions & { port: number } = { port: Number(env.PORT ?? '3100'), journalDir: env.ONCE_JOURNAL_DIR }
  if (env.ONCE_HSP_URL) {
    options.hspUrl = env.ONCE_HSP_URL
    options.allowExternalHsp = env.ONCE_ALLOW_EXTERNAL_HSP === '1'
    options.asset = {
      network: env.ONCE_ASSET_NETWORK ?? '', chain_id: Number(env.ONCE_ASSET_CHAIN_ID),
      contract_address: (env.ONCE_ASSET_CONTRACT ?? '') as Address, coin: env.ONCE_ASSET_COIN ?? '',
    }
  }
  return options
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const demo = await createDemoServer(config(process.env))
  console.error(`Once demo (${demo.mode} HSP) on ${demo.url}  seller ${demo.sellerUrl}/a2a  hsp ${demo.hspUrl}`)
  const stop = () => { void demo.close().then(() => process.exit(0)) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
