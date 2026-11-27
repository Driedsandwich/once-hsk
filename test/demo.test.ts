import { request as httpRequest } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { keccak256, stringToHex, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createDemoServer, type ApprovalInfo, type DemoOptions, type DemoServer } from '../src/demo/server.js'
import { McpClient } from '../src/hsp/mcpClient.js'
import { mockAbsent, mockAsset, selectMockAsset, startMock } from '../src/hsp/mockServer.js'
import { PayOnce, type Entry } from '../src/payOnce.js'
import { createPayOnceApi } from '../src/payOnceApi.js'
import { Store } from '../src/store.js'
import type { PayIntent } from '../src/types.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

async function start(options: DemoOptions = {}) {
  const demo = await createDemoServer(options)
  cleanups.push(() => demo.close())
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(demo.url + path, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() as Json }
  }
  const state = async () => (await call('GET', '/api/state')).body as Json
  async function until<T>(read: () => Promise<T | undefined | false>, what: string): Promise<T> {
    const stop = Date.now() + 10_000
    for (;;) {
      const value = await read()
      if (value) return value
      if (Date.now() > stop) throw new Error('Timed out waiting for ' + what)
      await new Promise(r => setTimeout(r, 20))
    }
  }
  const request = async (id: string) => (await state()).requests.find((r: Json) => r.requestId === id)
  const approval = (id: string, stage: string) => until(async () => {
    const waiting = (await request(id))?.awaitingApproval
    return waiting?.stage === stage ? waiting as Json : undefined
  }, `approval ${stage}`)
  return { demo, call, state, until, request, approval }
}

// What a person presses on the screen, done through the same HTTP door.
const press = (demo: DemoServer, stage: string) => async (info: ApprovalInfo) => {
  if (info.stage !== stage) return
  await fetch(demo.url + '/api/approve', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: info.requestId, stage: info.stage, approve: true, approvalId: info.approvalId }),
  })
}

describe('demo door', () => {
  it('quote -> approval 1 -> approval 2 -> dropped reply -> restart -> confirmed by query, one submit, one order', async () => {
    let hook: ((info: ApprovalInfo) => Promise<void>) | undefined
    const f = await start({ onApprovalRequested: info => hook?.(info) })
    hook = press(f.demo, 'submit') // approval 2 is pressed by the hook; approval 1 by hand below
    const events = new AbortController()
    let streamed = ''
    const stream = fetch(f.demo.url + '/api/events', { signal: events.signal }).then(async res => {
      const reader = res.body!.getReader()
      for (;;) { const { done, value } = await reader.read(); if (done) break; streamed += new TextDecoder().decode(value) }
    }).catch(() => undefined)
    cleanups.push(async () => { events.abort(); await stream })

    expect((await f.call('POST', '/api/fault', { kind: 'drop-after-submit' })).body.armed).toEqual({ 'drop-after-submit': true, 'expire-quote': false })
    const quote = await f.call('POST', '/api/quote', {})
    expect(quote.status).toBe(200)
    expect(quote.body.decision.action).toBe('request-approval')
    expect(quote.body.approvalText).toContain('0.50 USD')
    expect(quote.body.record.state).toBe('PREPARED')
    const id = quote.body.requestId as string

    // Nothing moves without the button.
    const first = await f.approval(id, 'sign')
    expect(first.text).toBe(quote.body.approvalText)
    await new Promise(r => setTimeout(r, 200))
    expect((await f.request(id)).state).toBe('PREPARED')
    expect((await f.state()).hsp).toEqual({ submitPaymentCalls: 0, accepted: 0, orders: 1 })
    expect((await f.call('POST', '/api/approve', { requestId: id, stage: 'submit', approve: true })).status).toBe(409)

    expect((await f.call('POST', '/api/approve', { requestId: id, stage: 'sign', approve: true, approvalId: first.approvalId })).status).toBe(200)
    // Approval 2 is pressed by the hook; the reply to the accepted submit is dropped, so the run ends in SUBMIT_INTENT.
    const lost = await f.until(async () => {
      const r = await f.request(id)
      return r.state === 'SUBMIT_INTENT' && !r.running && r.error ? r : undefined
    }, 'the lost submit reply')
    expect(lost.awaitingApproval).toBeNull()
    expect((await f.state()).hsp).toEqual({ submitPaymentCalls: 1, accepted: 1, orders: 1 })
    expect((await f.state()).faults).toEqual({ 'drop-after-submit': false, 'expire-quote': false })

    const restarted = await f.call('POST', '/api/restart', {})
    expect(restarted.status).toBe(200)
    expect(restarted.body.resumed).toEqual([{ requestId: id, state: 'CONFIRMED' }])
    const after = await f.state()
    const done = after.requests.find((r: Json) => r.requestId === id)
    expect(done.state).toBe('CONFIRMED')
    expect(done.txHash).toBe('mock-transaction')
    expect(done.error).toBeNull()
    expect(after.generation).toBe(2)
    expect(after.hsp).toEqual({ submitPaymentCalls: 1, accepted: 1, orders: 1 })
    expect(f.demo.audit!.calls.at(-1)).toBe('query_payment')
    expect(f.demo.audit!.calls.filter(c => c === 'create_order')).toHaveLength(1)

    const delivered = await f.call('POST', '/api/deliver', { requestId: id })
    expect(delivered.body.report['1h inflow (USD)']).toBe('125.00')
    await f.until(async () => streamed.includes('"state":"CONFIRMED"'), 'the event stream')
    for (const needle of ['event: snapshot', 'event: quote', 'event: approval', 'event: state', 'event: run-error', 'event: restart', '"phase":"resumed"']) {
      expect(streamed).toContain(needle)
    }
  }, 30_000)

  it('expire-quote: the rejected quote is renewed, both approvals are asked again, and the signature is new', async () => {
    const f = await start()
    expect((await f.call('POST', '/api/fault', { kind: 'expire-quote' })).body.armed['expire-quote']).toBe(true)
    const quote = await f.call('POST', '/api/quote', {})
    const id = quote.body.requestId as string
    const press1 = async (stage: string, expectedId?: string) => {
      const waiting = await f.approval(id, stage)
      expect(waiting.approvalId).not.toBe(expectedId)
      expect((await f.call('POST', '/api/approve', { requestId: id, stage, approve: true, approvalId: waiting.approvalId })).status).toBe(200)
      return waiting.approvalId as string
    }
    const sign1 = await press1('sign')
    await press1('submit')
    // The gateway answered 30043; the renewed quote needs a new approval 1.
    const sign2 = await f.until(async () => {
      const waiting = (await f.request(id)).awaitingApproval
      return waiting?.stage === 'sign' && waiting.approvalId !== sign1 ? waiting.approvalId as string : undefined
    }, 'the second approval 1')
    expect((await f.call('POST', '/api/approve', { requestId: id, stage: 'sign', approve: true, approvalId: sign1 })).status).toBe(409)
    await press1('sign', sign1)
    expect(sign2).not.toBe(sign1)
    await press1('submit')
    await f.until(async () => (await f.request(id)).state === 'CONFIRMED', 'CONFIRMED')

    const audit = f.demo.audit!
    expect(audit.submitCalls).toBe(2)
    expect(audit.accepted).toBe(1)
    expect(audit.orderCount).toBe(1)
    expect(audit.attemptedSignatures).toHaveLength(2)
    expect(new Set(audit.attemptedSignatures).size).toBe(2)
    expect(audit.acceptedSignatures).toEqual([audit.attemptedSignatures[1]])
    expect((await f.request(id)).history.some((h: Json) => h.note?.includes('30043'))).toBe(true)
  }, 30_000)

  it('declining an approval stops the run without signing or sending', async () => {
    const f = await start()
    const id = (await f.call('POST', '/api/quote', {})).body.requestId as string
    const waiting = await f.approval(id, 'sign')
    expect((await f.call('POST', '/api/approve', { requestId: id, stage: 'sign', approve: false, approvalId: waiting.approvalId })).status).toBe(200)
    const stopped = await f.until(async () => {
      const r = await f.request(id)
      return !r.running && r.error ? r : undefined
    }, 'the stopped run')
    expect(stopped.state).toBe('PREPARED')
    expect(f.demo.audit!.submitCalls).toBe(0)
    expect(f.demo.audit!.signed).toHaveLength(0)
  })

  it('restart while an approval is open cancels it and asks again from the journal', async () => {
    const f = await start()
    const id = (await f.call('POST', '/api/quote', {})).body.requestId as string
    const before = await f.approval(id, 'sign')
    const restarted = await f.call('POST', '/api/restart', {})
    expect(restarted.body.resumed).toEqual([{ requestId: id, state: 'PREPARED' }])
    const again = await f.approval(id, 'sign')
    expect(again.approvalId).not.toBe(before.approvalId)
    expect((await f.call('POST', '/api/approve', { requestId: id, stage: 'sign', approve: true, approvalId: before.approvalId })).status).toBe(409)
    expect(f.demo.audit!.orderCount).toBe(1)
  })

  it('skips the purchase when the buyer already knows the answer, and rejects bad requests', async () => {
    const f = await start()
    const known = await f.call('POST', '/api/quote', { local: { '1h inflow (USD)': '1', '1h outflow (USD)': '2' } })
    expect(known.body.decision).toEqual({ action: 'skip', reason: 'already-known' })
    expect((await f.state()).requests).toEqual([])
    expect((await f.state()).hsp.orders).toBe(0)
    expect((await f.call('POST', '/api/fault', { kind: 'nope' })).status).toBe(400)
    expect((await f.call('POST', '/api/approve', { requestId: keccak256(stringToHex('x')), stage: 'sign', approve: true })).status).toBe(409)
    expect((await f.call('GET', '/api/missing')).status).toBe(404)
    const cross = await new Promise<number>((resolve, reject) => {
      const url = new URL(f.demo.url + '/api/state')
      httpRequest({ host: url.hostname, port: url.port, path: url.pathname, headers: { Origin: 'http://evil.example' } },
        res => { res.resume(); resolve(res.statusCode ?? 0) }).on('error', reject).end()
    })
    expect(cross).toBe(403)
  })

  it('only listens on 127.0.0.1 and refuses a remote HSP URL unless allowed', async () => {
    const f = await start()
    expect(new URL(f.demo.url).hostname).toBe('127.0.0.1')
    expect(new URL(f.demo.sellerUrl).hostname).toBe('127.0.0.1')
    await expect(createDemoServer({ hspUrl: 'https://hsp.example.invalid/mcp', asset: mockAsset })).rejects.toThrow('non-loopback')
    // An incomplete asset (what unset environment variables would produce) is refused at start-up.
    await expect(createDemoServer({
      hspUrl: 'http://127.0.0.1:9/mcp', asset: { network: '', chain_id: Number.NaN, contract_address: '' as Address, coin: '' },
    })).rejects.toThrow('valid asset')
  })

  it('with a configured HSP URL (a second local mock, no real network) the whole flow runs and the mock-only parts are off', async () => {
    const other = await startMock()
    cleanups.push(other.close)
    let hook: ((info: ApprovalInfo) => Promise<void>) | undefined
    const f = await start({ hspUrl: other.url, asset: mockAsset, onApprovalRequested: info => hook?.(info) })
    hook = async info => { await press(f.demo, info.stage)(info) } // both approvals pressed through the hook
    expect(f.demo.mode).toBe('external')
    expect(f.demo.audit).toBeUndefined()
    const quote = await f.call('POST', '/api/quote', {})
    const id = quote.body.requestId as string
    await f.until(async () => (await f.request(id)).state === 'CONFIRMED', 'CONFIRMED')
    const state = await f.state()
    expect(state.mode).toBe('external')
    expect(state.hsp).toBeNull()
    expect(state.faults).toBeNull()
    expect((await f.call('POST', '/api/fault', { kind: 'drop-after-submit' })).status).toBe(409)
    expect(other.audit.submitCalls).toBe(1)
    expect(other.audit.orderCount).toBe(1)
    expect((await f.call('POST', '/api/deliver', { requestId: id })).status).toBe(200)
  })
})

describe('secrets', () => {
  it('the signing key never reaches the journal, the state or the event stream (the payer address does: control)', async () => {
    const key = generatePrivateKey()
    const account = privateKeyToAccount(key)
    const dir = await mkdtemp(join(tmpdir(), 'once-secret-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    let hook: ((info: ApprovalInfo) => Promise<void>) | undefined
    const f = await start({ account, journalDir: dir, onApprovalRequested: info => hook?.(info) })
    hook = async info => { await press(f.demo, info.stage)(info) }
    const events = new AbortController()
    let streamed = ''
    const stream = fetch(f.demo.url + '/api/events', { signal: events.signal }).then(async res => {
      const reader = res.body!.getReader()
      for (;;) { const { done, value } = await reader.read(); if (done) break; streamed += new TextDecoder().decode(value) }
    }).catch(() => undefined)
    cleanups.push(async () => { events.abort(); await stream })
    const id = (await f.call('POST', '/api/quote', {})).body.requestId as string
    await f.until(async () => (await f.request(id)).state === 'CONFIRMED', 'CONFIRMED')
    const names = (await readdir(dir)).filter(n => n.endsWith('.jsonl'))
    expect(names).toHaveLength(1)
    const everything = [
      await readFile(join(dir, names[0]!), 'utf8'), JSON.stringify(await f.state()), streamed,
    ].join('\n').toLowerCase()
    expect(everything.split(key.slice(2).toLowerCase()).length - 1).toBe(0)
    expect(everything.split(account.address.toLowerCase()).length - 1).toBeGreaterThan(3)
  })
})

describe('PayOnceApi adapter', () => {
  it('maps PayIntent to the core, is idempotent, and reads the journal without taking its lock', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const dir = await mkdtemp(join(tmpdir(), 'once-adapter-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const mock = await startMock()
    cleanups.push(mock.close)
    const hsp = await McpClient.connect({ url: mock.url, ipv4Only: true })
    cleanups.push(() => hsp.close())
    const store = await Store.open<Entry>(dir)
    const pay = new PayOnce({
      hsp, store, selectAsset: selectMockAsset, isDefinitivelyAbsent: mockAbsent,
      approveSign: async () => true, approveSubmit: async () => true,
      signTypedData: m => account.signTypedData(m),
    })
    const api = createPayOnceApi({
      pay, store, network: mockAsset.network, token: mockAsset.contract_address, protocol: 'eip3009',
      resolveBuyer: () => account.address as Address,
    })
    const intent: PayIntent = {
      buyerAgentId: 'Research Agent', intentNonce: 'order-1',
      terms: {
        sellerAgentId: 'Pool Data Agent', payTo: '0x0000000000000000000000000000000000000002', amountUsd: '0.50',
        item: 'HSKSwap 1h flow report', itemVersionHash: keccak256(stringToHex('v1')),
        expiresAt: new Date(Date.now() + 600_000).toISOString(), whatYouLearn: 'x',
      },
    }
    const [a, b] = await Promise.all([api.payOnce(intent), api.payOnce(structuredClone(intent))])
    expect(a.requestId).toBe(api.requestIdOf(intent))
    expect(b.requestId).toBe(a.requestId)
    expect(a.state).toBe('CONFIRMED')
    expect(a.txHash).toBe('mock-transaction')
    expect(a.flowId).toMatch(/^flow-/)
    expect(a.submitCalls).toBe(1)
    expect(a.history.map(h => h.state)).toEqual(['NEW', 'NEW', 'ORDER_CREATED', 'PREPARED', 'APPROVED_SIGN', 'SIGNED',
      'FINALIZED', 'APPROVED_SUBMIT', 'SUBMIT_INTENT', 'SUBMITTED', 'CONFIRMED'])
    // A repeat after completion calls nothing on the HSP side.
    const calls = mock.audit.calls.length
    expect((await api.payOnce(intent)).state).toBe('CONFIRMED')
    expect(mock.audit.calls.length).toBe(calls)
    expect(mock.audit.submitCalls).toBe(1)
    expect(mock.audit.orderCount).toBe(1)
    expect(await api.get(a.requestId)).toEqual(a)
    expect(await api.get(keccak256(stringToHex('unknown')))).toBeUndefined()
    expect(await api.get('0x../../etc/passwd' as `0x${string}`)).toBeUndefined()
    expect(await api.resumeAll()).toEqual([])
    // A different nonce is a different payment.
    expect(api.requestIdOf({ ...intent, intentNonce: 'order-2' })).not.toBe(a.requestId)
  }, 30_000)
})
