import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import type { Hex } from 'viem'
import { Store } from '../src/store.js'
import { PayOnce, requestId, type Options, type Approval, type Clock, type Entry } from '../src/payOnce.js'
import { startMock, mockAbsent, selectMockAsset, type MockOptions } from '../src/hsp/mockServer.js'
import { McpClient } from '../src/hsp/mcpClient.js'
import { mockIntent } from '../scripts/mockIntent.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function setup(mock: MockOptions = {}) {
  let time = Date.UTC(2026, 0, 1)
  const clock: Clock = { now: () => time, async sleep(ms) { time += ms } }
  const account = privateKeyToAccount(generatePrivateKey())
  const intent = mockIntent(account.address, time)
  const id = requestId(intent)
  const dir = await mkdtemp(join(tmpdir(), 'pay-once-test-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const server = await startMock({ now: clock.now, ...mock })
  cleanups.push(server.close)
  const reviews: { gate: string; review: Approval }[] = []
  const entries = async (): Promise<Entry[]> => (await readFile(join(dir, id + '.jsonl'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line))
  async function engine(overrides: Partial<Options> = {}) {
    const hsp = await McpClient.connect({ url: server.url, ipv4Only: true })
    cleanups.push(() => hsp.close())
    return new PayOnce({
      hsp, store: await Store.open<Entry>(dir), selectAsset: selectMockAsset,
      signTypedData: m => account.signTypedData(m), isDefinitivelyAbsent: mockAbsent,
      approveSign: async review => { reviews.push({ gate: 'sign', review }); return true },
      approveSubmit: async review => { reviews.push({ gate: 'submit', review }); return true },
      clock, ...overrides,
    })
  }
  return { engine, id, intent, server, dir, audit: server.audit, clock, entries, reviews }
}

const successPath = [
  'NEW', 'ORDER_CREATED', 'PREPARED', 'APPROVED_SIGN', 'SIGNED', 'FINALIZED',
  'APPROVED_SUBMIT', 'SUBMIT_INTENT', 'SUBMITTED', 'CONFIRMED',
] as const
it.each(successPath)('fsync(%s) → crash → reopened journal reaches CONFIRMED with one submit', async boundary => {
  const f = await setup()
  const first = await f.engine({ afterRecord(e) { if (e.step.state === boundary) throw Error('crash') } })
  await expect(first.pay(f.intent)).rejects.toThrow('crash')
  expect((await f.entries()).at(-1)?.step.state).toBe(boundary)
  const start = f.audit.calls.length
  const result = await (await f.engine()).resume(f.id)
  if (boundary === 'SUBMIT_INTENT') {
    expect(f.audit.queries.at(-1)!.at - f.audit.queries[0]!.at).toBe(300_000)
    expect(new Set(f.audit.signed).size).toBe(2)
  }
  if (boundary === 'SUBMIT_INTENT' || boundary === 'SUBMITTED') expect(f.audit.calls[start]).toBe('query_payment')
  expect(result.state).toBe('CONFIRMED')
  expect(f.audit.orderCount).toBe(1)
  expect(f.audit.submitCalls).toBe(1)
  expect(f.audit.accepted).toBe(1)
})

it('drops the HTTP reply after acceptance; a restarted client only queries', async () => {
  const f = await setup({ dropSubmitResponseOnce: true })
  await expect((await f.engine()).pay(f.intent)).rejects.toThrow()
  expect((await f.entries()).at(-1)?.step.state).toBe('SUBMIT_INTENT')
  const start = f.audit.calls.length
  await f.clock.sleep(900_000) // the lost reply outlives both the quote and polling window
  const r = await (await f.engine()).resume(f.id)
  expect(r.state).toBe('CONFIRMED')
  expect(f.audit.calls.slice(start)).toEqual(['query_payment'])
  expect(f.audit.submitCalls).toBe(1)
})

it('an HTTP timeout during a delayed accepted submit also recovers by query', async () => {
  const f = await setup({ submitDelayMs: 400 })
  const client = await McpClient.connect({ url: f.server.url, ipv4Only: true })
  cleanups.push(() => client.close())
  const p = await f.engine({ hsp: {
    call: (tool, input, timeout) => client.call(tool, input, tool === 'submit_payment' ? 100 : timeout),
  } })
  await expect(p.pay(f.intent)).rejects.toThrow()
  expect(f.audit.accepted).toBe(1)
  expect(await (await f.engine()).resume(f.id)).toMatchObject({ state: 'CONFIRMED' })
  expect(f.audit.submitCalls).toBe(1)
})

it('expiry during human approval discards the signed mandate and renews both approvals', async () => {
  const f = await setup()
  let first = true
  const p = await f.engine({ afterRecord: async e => {
    if (first && e.step.state === 'APPROVED_SUBMIT') { first = false; await f.clock.sleep(300_000) }
  } })
  expect((await p.pay(f.intent)).state).toBe('CONFIRMED')
  expect(f.audit.signed).toHaveLength(2)
  expect(new Set(f.audit.signed).size).toBe(2)
  expect(f.audit.attemptedSignatures).toEqual([f.audit.signed[1]])
  expect(f.reviews.map(r => r.gate)).toEqual(['sign', 'submit', 'sign', 'submit'])
  for (const { review } of f.reviews) expect(review).toMatchObject({
    payer: f.intent.buyer, pay_to: f.intent.seller, token_total_raw: '1000000',
  })
  expect(f.audit.orderCount).toBe(1)
})

it('a gateway 30043 counts as a call; only the fresh signature is accepted', async () => {
  const f = await setup({ rejectExpiredOnce: true })
  expect((await (await f.engine({ isDefinitivelyAbsent: undefined })).pay(f.intent)).state).toBe('CONFIRMED')
  expect(f.audit.submitCalls).toBe(2)
  expect(f.audit.accepted).toBe(1)
  expect(f.audit.attemptedSignatures).toEqual(f.audit.signed)
  expect(new Set(f.audit.attemptedSignatures).size).toBe(2)
  expect(f.audit.acceptedSignatures).toEqual([f.audit.signed[1]])
  expect(f.audit.calls.slice(f.audit.calls.indexOf('submit_payment') + 1, -1))
    .toEqual(['prepare_payment', 'finalize_payment', 'submit_payment'])
})

it('serializes two concurrent clients sharing a journal', async () => {
  const f = await setup()
  const [a, b] = await Promise.all([f.engine(), f.engine()])
  const [x, y] = await Promise.all([a.pay(f.intent), b.pay(f.intent)])
  expect(x).toEqual(y)
  expect(x.state).toBe('CONFIRMED')
  expect(f.audit.orderCount).toBe(1)
  expect(f.audit.submitCalls).toBe(1)
})

it('polls all intermediate statuses including timeout every 15 seconds on the original flow', async () => {
  const f = await setup({ statuses: [
    { status: 'payment-submitted' }, { status: 'payment-verified' }, { status: 'payment-processing' },
    { status: 'payment-included' }, { status: 'payment-timeout' },
    { status: 'payment-finalized', payment: { tx_signature: 'mock-tx' }, attribution_verified: true },
  ] })
  const start = f.clock.now()
  const r = await (await f.engine()).pay(f.intent)
  expect(r).toMatchObject({ state: 'CONFIRMED', status: 'payment-finalized', tx_signature: 'mock-tx', attribution_verified: true })
  expect(f.audit.queries).toEqual(Array.from({ length: 6 }, (_, i) => ({
    flow_id: r.flow_id, merchant: f.intent.terms.merchant, at: start + 15_000 * i,
  })))
  expect(f.audit.orderCount).toBe(1)
  expect(f.audit.submitCalls).toBe(1)
})

it('returns both identifiers after ten minutes and resumes from PENDING_CONFIRMATION after a crash', async () => {
  const sequence: NonNullable<MockOptions['statuses']> = [{ status: 'payment-timeout' }]
  const f = await setup({ statuses: sequence })
  const start = f.clock.now()
  const p = await f.engine({ afterRecord(e) { if (e.step.state === 'PENDING_CONFIRMATION') throw Error('crash') } })
  await expect(p.pay(f.intent)).rejects.toThrow('crash')
  expect(f.clock.now() - start).toBe(600_000)
  const resumed = await f.engine()
  const pending = await resumed.resume(f.id)
  expect(pending).toMatchObject({
    state: 'PENDING_CONFIRMATION', requestId: f.id, flow_id: expect.any(String),
    payment_request_id: expect.any(String), attribution_verified: false,
  })
  sequence.push({ status: 'payment-safe' })
  expect(await resumed.resume(f.id)).toMatchObject({ state: 'CONFIRMED', flow_id: pending.flow_id })
  expect(f.audit.orderCount).toBe(1)
  expect(f.audit.submitCalls).toBe(1)
})

it('FAILED retains status_reason across a crash and stays terminal', async () => {
  const f = await setup({ statuses: [{ status: 'payment-failed', status_reason: 'mock rejection' }] })
  const p = await f.engine({ afterRecord(e) { if (e.step.state === 'FAILED') throw Error('crash') } })
  await expect(p.pay(f.intent)).rejects.toThrow('crash')
  expect(await (await f.engine()).resume(f.id)).toMatchObject({
    state: 'FAILED', status_reason: 'mock rejection', attribution_verified: false,
  })
  expect(f.audit.submitCalls).toBe(1)
})

it('an unmapped query error cannot authorize a new signature or submit even after expiry', async () => {
  const f = await setup()
  const p = await f.engine({ afterRecord(e) { if (e.step.state === 'SUBMIT_INTENT') throw Error('crash') } })
  await expect(p.pay(f.intent)).rejects.toThrow('crash')
  const resumed = await f.engine({ isDefinitivelyAbsent: undefined })
  expect((await resumed.resume(f.id)).state).toBe('PENDING_CONFIRMATION')
  expect(f.audit.submitCalls).toBe(0)
  expect(f.audit.calls.filter(t => t === 'prepare_payment')).toHaveLength(1)
})

it.each(['approveSign', 'approveSubmit'] as const)('requires explicit true from %s', async gate => {
  const f = await setup()
  const p = await f.engine({ [gate]: async () => false })
  await expect(p.pay(f.intent)).rejects.toThrow('declined')
  expect(f.audit.submitCalls).toBe(0)
  expect(f.audit.signed).toHaveLength(gate === 'approveSign' ? 0 : 1)
})

it('passes a nested Permit2 fixture unchanged through signing and finalization', async () => {
  const f = await setup()
  f.intent.terms.protocol = 'permit2'
  expect((await (await f.engine()).pay(f.intent)).state).toBe('CONFIRMED')
  expect(f.audit.submitCalls).toBe(1)
})

it('refuses connection when finalize_payment is absent', async () => {
  const f = await setup({ omitTool: 'finalize_payment' })
  await expect(f.engine()).rejects.toThrow('Missing required HSP tools: finalize_payment')
  expect(f.audit.calls).toEqual([])
})

it('fails closed on an incomplete journal tail', async () => {
  const f = await setup()
  await (await f.engine()).pay(f.intent)
  await appendFile(join(f.dir, f.id + '.jsonl'), '{"requestId"')
  await expect(f.engine()).rejects.toThrow('Incomplete journal tail')
  expect(f.audit.submitCalls).toBe(1)
})

it('does not duplicate an order if create succeeded but its response was lost', async () => {
  const f = await setup()
  const client = await McpClient.connect({ url: f.server.url, ipv4Only: true })
  cleanups.push(() => client.close())
  const p = await f.engine({ hsp: { async call(tool, input) {
    const r = await client.call(tool, input)
    if (tool === 'create_order') throw Error('lost create reply')
    return r
  } } })
  await expect(p.pay(f.intent)).rejects.toThrow('lost create reply')
  await expect((await f.engine()).resume(f.id)).rejects.toThrow('Order creation outcome unknown')
  expect(f.audit.orderCount).toBe(1)
})

it('requestId binds buyer, seller, terms and intentId', async () => {
  const { intent, id } = await setup()
  const variants: Hex[] = [
    requestId({ ...intent, buyer: intent.seller }), requestId({ ...intent, seller: intent.buyer }),
    requestId({ ...intent, terms: { ...intent.terms, usd: '2.00' } }), requestId({ ...intent, intentId: 'second' }),
  ]
  expect(new Set([id, ...variants]).size).toBe(5)
})

it('queries first if killed after recording a definitive gateway expiry', async () => {
  const f = await setup({ rejectExpiredOnce: true })
  const p = await f.engine({ afterRecord(e) {
    if (e.step.state === 'SUBMIT_INTENT' && e.step.gatewayExpired) throw Error('crash')
  } })
  await expect(p.pay(f.intent)).rejects.toThrow('crash')
  const start = f.audit.calls.length
  expect((await (await f.engine()).resume(f.id)).state).toBe('CONFIRMED')
  expect(f.audit.calls.slice(start, start + 2)).toEqual(['query_payment', 'prepare_payment'])
  expect(f.audit.accepted).toBe(1)
  expect(f.audit.orderCount).toBe(1)
  expect(f.audit.submitCalls).toBe(2)
  expect(new Set(f.audit.attemptedSignatures).size).toBe(2)
})

it('rechecks expiry after the intent fsync, before sending any bytes', async () => {
  const f = await setup()
  let aged = false
  const p = await f.engine({ afterRecord: async e => {
    if (e.step.state === 'SUBMIT_INTENT' && !aged) { aged = true; await f.clock.sleep(300_000) }
  } })
  expect((await p.pay(f.intent)).state).toBe('CONFIRMED')
  expect(f.audit.signed).toHaveLength(2)
  expect(f.audit.attemptedSignatures).toEqual([f.audit.signed[1]])
})

it('serves fee, order and payment-id queries through the same MCP endpoint', async () => {
  const f = await setup()
  const result = await (await f.engine()).pay(f.intent)
  const client = await McpClient.connect({ url: f.server.url, ipv4Only: true })
  cleanups.push(() => client.close())
  expect(await client.call('estimate_fee', {})).toMatchObject({ mock: true })
  expect(await client.call('get_order', { flow_id: result.flow_id })).toMatchObject({ payment_request_id: result.payment_request_id })
  expect(await client.call('query_payment', {
    payment_request_id: result.payment_request_id, expected_merchant_name: f.intent.terms.merchant,
  })).toMatchObject({ status: 'payment-safe' })
  await expect(client.call('query_payment', {
    flow_id: result.flow_id, expected_merchant_name: 'another team',
  })).rejects.toThrow()
})
