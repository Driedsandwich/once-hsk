import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import type { Protocol } from './hsp/types.js'
import { requestId, type Entry, type Intent, type PayOnce } from './payOnce.js'
import type { Store } from './store.js'
import type { PayIntent, PayOnceApi, PayRecord, PayState } from './types.js'

/**
 * Adapter: the surrounding parts (seller, buyer, MCP) talk to `PayOnceApi`; the core is `PayOnce`.
 * This file only maps shapes. It adds no payment logic of its own.
 */
export interface PayOnceApiConfig {
  pay: PayOnce
  /** Only `store.directory` is used (read-only access to the journals). */
  store: Pick<Store<Entry>, 'directory'>
  /** PayIntent carries a name; the core needs an address. */
  resolveBuyer(buyerAgentId: string): Address
  /** These three fix the cart (and therefore the requestId); the PayIntent does not carry them. */
  network: string
  token: Address
  protocol: Protocol
  /**
   * Resolves when the request is waiting for a human approval. payOnce/resumeAll then return the
   * current record instead of holding the caller until the human answers. The run itself goes on.
   */
  awaitingHuman?(id: Hex, signal: AbortSignal): Promise<void>
  /** Errors of runs that nobody is awaiting any more (declined approval, lost connection...). */
  onError?(id: Hex, error: unknown): void
}

export interface PayOnceApiHandle extends PayOnceApi {
  requestIdOf(intent: PayIntent): Hex
  isRunning(id: Hex): boolean
  /** Resolves when every run started through this adapter has ended. */
  idle(): Promise<void>
}

export function toIntent(
  config: Pick<PayOnceApiConfig, 'resolveBuyer' | 'network' | 'token' | 'protocol'>, intent: PayIntent,
): Intent {
  const { terms } = intent
  if (typeof intent.intentNonce !== 'string' || !intent.intentNonce.trim()) throw new Error('Invalid payment intent')
  return {
    buyer: config.resolveBuyer(intent.buyerAgentId),
    seller: terms.payTo,
    // The name, the nonce and the item version all decide "the same payment".
    intentId: JSON.stringify([intent.buyerAgentId, intent.intentNonce, terms.itemVersionHash]),
    terms: {
      merchant: terms.sellerAgentId, label: terms.item, usd: terms.amountUsd, cartExpiry: terms.expiresAt,
      network: config.network, token: config.token, protocol: config.protocol,
    },
  }
}

const idPattern = /^0x[0-9a-f]{64}$/
const terminal = new Set(['CONFIRMED', 'FAILED'])

/** Journals are append-only; reading without the lock never blocks on a run that waits for a human. */
async function readEntries(directory: string, id: string): Promise<Entry[]> {
  if (!idPattern.test(id)) return []
  let text: string
  try { text = await readFile(join(directory, id + '.jsonl'), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const lines = text.split('\n')
  lines.pop() // empty after the last newline, or a line still being written
  return lines.filter(Boolean).map(line => JSON.parse(line) as Entry)
}

function note(entry: Entry): string | undefined {
  const step = entry.step
  if (step.state === 'NEW' && step.createAttempted) return 'create_order attempted'
  if (step.state === 'SUBMIT_INTENT' && step.gatewayExpired) return 'submit_payment rejected: quote expired (30043)'
  if (step.state === 'FAILED') return typeof step.observation.status_reason === 'string' ? step.observation.status_reason : undefined
  return undefined
}

/**
 * submitCalls = submit attempts recorded in the journal. A SUBMIT_INTENT record is written just before
 * submit_payment; it is not counted when the next record is PREPARED (the quote had expired and no call
 * was made). If the process died right after the record, the call may or may not have been made, so this
 * is an upper bound. The mock HSP's own audit counter is the exact number of real calls.
 */
export function toRecord(entries: readonly Entry[]): PayRecord | undefined {
  const last = entries.at(-1)
  if (!last) return undefined
  let submitCalls = 0
  entries.forEach((entry, i) => {
    if (entry.step.state === 'SUBMIT_INTENT' && !entry.step.gatewayExpired &&
        entries[i + 1]?.step.state !== 'PREPARED') submitCalls++
  })
  const step = last.step
  const order = 'order' in step ? step.order : undefined
  const observation = 'observation' in step ? step.observation : undefined
  return {
    requestId: last.requestId,
    state: step.state satisfies PayState,
    flowId: order?.flow_id,
    paymentRequestId: order?.payment_request_id,
    submitCalls,
    history: entries.map(entry => {
      const n = note(entry)
      return { state: entry.step.state, at: new Date(entry.at).toISOString(), ...(n ? { note: n } : {}) }
    }),
    txHash: observation?.payment?.tx_signature,
  }
}

export function createPayOnceApi(config: PayOnceApiConfig): PayOnceApiHandle {
  const running = new Map<Hex, { raw: Promise<unknown>; done: Promise<void> }>()

  function launch(id: Hex, run: () => Promise<unknown>) {
    const current = running.get(id)
    if (current) return current
    const raw = Promise.resolve().then(run)
    const done = raw.then(() => undefined, error => {
      try { config.onError?.(id, error) } catch { /* a reporting hook must not break the run's cleanup */ }
    }).finally(() => { running.delete(id) })
    const entry = { raw, done }
    running.set(id, entry)
    return entry
  }

  const get = async (id: `0x${string}`) => toRecord(await readEntries(config.store.directory, id.toLowerCase()))

  /** Waits until the run ends or waits for a human, then returns the journal's view. */
  async function settle(id: Hex, entry: { raw: Promise<unknown> }): Promise<PayRecord> {
    const stop = new AbortController()
    try {
      const outcomes: Promise<unknown>[] = [entry.raw]
      if (config.awaitingHuman) outcomes.push(config.awaitingHuman(id, stop.signal))
      await Promise.race(outcomes)
    } finally { stop.abort() }
    const record = await get(id)
    if (!record) throw new Error('No journal record for ' + id)
    return record
  }

  return {
    requestIdOf: intent => requestId(toIntent(config, intent)),
    isRunning: id => running.has(id),
    async idle() { while (running.size) await Promise.all([...running.values()].map(entry => entry.done)) },
    async payOnce(intent) {
      const core = toIntent(config, intent)
      const id = requestId(core)
      return settle(id, launch(id, () => config.pay.pay(core)))
    },
    get,
    async resumeAll() {
      const pending: Hex[] = []
      for (const name of (await readdir(config.store.directory)).sort()) {
        if (!name.endsWith('.jsonl')) continue
        const id = name.slice(0, -6) as Hex
        const last = (await readEntries(config.store.directory, id)).at(-1)
        if (last && !terminal.has(last.step.state)) pending.push(id)
      }
      const settled = await Promise.allSettled(pending.map(id => settle(id, launch(id, () => config.pay.resume(id)))))
      const records: PayRecord[] = []
      for (const [i, outcome] of settled.entries()) {
        // A run that failed is reported through onError; its journal record still shows where it stopped.
        const record = outcome.status === 'fulfilled' ? outcome.value : await get(pending[i]!)
        if (record) records.push(record)
      }
      return records
    },
  }
}
