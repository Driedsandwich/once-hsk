import { hashTypedData, isAddress, keccak256, stringToHex, verifyTypedData } from 'viem'
import type { Address, Hex } from 'viem'
import { isObject, statuses, ToolError } from './hsp/types.js'
import type { Asset, CreateOrder, Hsp, Mandate, Order, Payment, Protocol, Quote, TypedMessage } from './hsp/types.js'
import { Store, type Journal } from './store.js'

export interface Intent {
  buyer: Address
  seller: Address
  intentId: string
  terms: {
    merchant: string
    label: string
    usd: string
    cartExpiry: string
    network: string
    token: Address
    protocol: Protocol
  }
}

export function requestId(intent: Intent): Hex {
  const t = intent.terms
  if (![intent.buyer, intent.seller, t.token].every(a => isAddress(a)) ||
      ![intent.intentId, t.merchant, t.label, t.network].every(s => typeof s === 'string' && s.trim()) ||
      !/^\d+(\.\d+)?$/.test(t.usd) || !/[1-9]/.test(t.usd) ||
      !['eip3009', 'permit2'].includes(t.protocol) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(t.cartExpiry) ||
      !Number.isFinite(Date.parse(t.cartExpiry))) throw new Error('Invalid payment intent')
  const terms = [t.merchant, t.label, t.usd, new Date(t.cartExpiry).toISOString(),
    t.network, t.token.toLowerCase(), t.protocol]
  return keccak256(stringToHex(JSON.stringify([
    intent.buyer.toLowerCase(), intent.seller.toLowerCase(), terms, intent.intentId,
  ])))
}

export interface Approval {
  requestId: Hex
  payment_request_id: string
  payer: Address
  pay_to: Address
  token_total_raw: string
  quote_expires_at: string
  eip712: TypedMessage
}
export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}
export const wallClock: Clock = {
  now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

interface PlacedOrder extends Order { asset: Asset }
interface Prepared { order: PlacedOrder; quote: Quote }
interface Tracking extends Prepared {
  pollStarted: number
  accepted: boolean
  gatewayExpired?: boolean
  observation?: Payment
}

type Step =
  | { state: 'NEW'; createAttempted?: boolean }
  | { state: 'ORDER_CREATED'; order: PlacedOrder }
  | ({ state: 'PREPARED' | 'APPROVED_SIGN' } & Prepared)
  | ({ state: 'SIGNED'; signature: Hex } & Prepared)
  | ({ state: 'FINALIZED' | 'APPROVED_SUBMIT'; mandate: Mandate } & Prepared)
  | ({ state: 'SUBMIT_INTENT' | 'SUBMITTED' | 'PENDING_CONFIRMATION' } & Tracking)
  | { state: 'CONFIRMED' | 'FAILED'; order: Order; observation: Payment }

export interface Entry {
  requestId: Hex
  intent: Intent
  at: number
  step: Step
}
export interface Result extends Order {
  requestId: Hex
  state: 'CONFIRMED' | 'FAILED' | 'PENDING_CONFIRMATION'
  status?: Payment['status']
  status_reason?: unknown
  tx_signature?: string
  attribution_verified: boolean
}

export interface Options {
  hsp: Hsp
  store: Store<Entry>
  /** Map the gateway's get_chain_config response to the chosen network/token. */
  selectAsset(config: unknown, terms: Intent['terms']): Asset
  approveSign(review: Approval): Promise<boolean>
  approveSubmit(review: Approval): Promise<boolean>
  signTypedData(message: TypedMessage): Promise<Hex>
  /** Only a conclusive, gateway-specific "no accepted payment" may permit renewal. */
  isDefinitivelyAbsent?(error: ToolError): boolean
  clock?: Clock
  afterRecord?(entry: Entry): void | Promise<void>
}

function makeOrder(id: Hex, i: Intent, asset: Asset): CreateOrder {
  const t = i.terms
  if (asset.network !== t.network || asset.contract_address.toLowerCase() !== t.token.toLowerCase() ||
      !Number.isSafeInteger(asset.chain_id) || !asset.coin) throw new Error('Asset selection mismatch')
  return {
    merchant_name: t.merchant, pay_to: i.seller,
    cart_mandate: { contents: {
      id, merchant_name: t.merchant, cart_expiry: t.cartExpiry, user_cart_confirmation_required: true,
      payment_request: {
        method_data: [{ supported_methods: 'https://www.x402.org/', data: {
          ...asset, x402Version: 2, pay_to: i.seller,
        } }],
        details: { id, total: { label: t.label, amount: { currency: 'USD', value: t.usd } } },
      },
    } },
  }
}

function validateQuote(q: Quote, i: Intent, order: PlacedOrder) {
  if (!q || !isObject(q.eip712) || !isObject(q.eip712.types) || !isObject(q.eip712.domain) ||
      !isObject(q.eip712.message) || !Array.isArray(q.eip712.types[q.eip712.primaryType]) ||
      q.pay_to?.toLowerCase() !== i.seller.toLowerCase() || q.payer?.toLowerCase() !== i.buyer.toLowerCase() ||
      Number(q.eip712.domain.chainId) !== order.asset.chain_id ||
      q.payment_request_id !== order.payment_request_id || typeof q.token_total_raw !== 'string' ||
      !/^\d+$/.test(q.token_total_raw) || !Number.isFinite(Date.parse(q.quote_expires_at)) ||
      typeof q.cart_hash !== 'string' || !q.cart_hash ||
      q.payment_payload == null || q.payment_mandate_contents == null) throw new Error('Invalid HSP quote')
  if (i.terms.protocol === 'eip3009') {
    const m = q.eip712.message
    if (q.eip712.primaryType !== 'TransferWithAuthorization' ||
        String(m.from).toLowerCase() !== i.buyer.toLowerCase() ||
        String(m.to).toLowerCase() !== i.seller.toLowerCase() ||
        String(m.value) !== q.token_total_raw ||
        q.eip712.domain.verifyingContract?.toLowerCase() !== i.terms.token.toLowerCase()) {
      throw new Error('EIP-3009 authorization differs from payment terms')
    }
  }
}

export class PayOnce {
  private readonly clock: Clock
  constructor(private readonly opts: Options) { this.clock = opts.clock ?? wallClock }

  pay(intent: Intent) {
    const copy = structuredClone(intent)
    return this.run(requestId(copy), copy)
  }
  resume(id: Hex) { return this.run(id) }

  private run(id: Hex, initial?: Intent): Promise<Result> {
    return this.opts.store.withRequest(id, async journal => {
      const intent = journal.last?.intent ?? initial
      if (!intent || requestId(intent) !== id) throw new Error('Unknown request or invalid journal identity')
      return this.drive(journal, id, intent)
    })
  }

  private async drive(journal: Journal<Entry>, id: Hex, intent: Intent): Promise<Result> {
    const { hsp } = this.opts
    let step = journal.last?.step
    let refreshes = 0
    const record = async (next: Step) => {
      const entry = { requestId: id, intent, at: this.clock.now(), step: next }
      await journal.append(entry)
      step = next
      await this.opts.afterRecord?.(structuredClone(entry))
    }
    const expired = (q: Quote) => this.clock.now() >= Date.parse(q.quote_expires_at)
    const prepare = async (order: PlacedOrder, previous?: Quote) => {
      if (++refreshes > 8) throw new Error('Repeated quote expiry; resume the same request')
      const quote = await hsp.call('prepare_payment', {
        flow_id: order.flow_id, payer: intent.buyer, protocol: intent.terms.protocol,
      })
      validateQuote(quote, intent, order)
      if (previous && hashTypedData(previous.eip712) === hashTypedData(quote.eip712)) {
        throw new Error('Renewal returned the previous authorization')
      }
      await record({ state: 'PREPARED', order, quote })
    }
    const approve = async (quote: Quote, hook: Options['approveSign']) => {
      const { payer, pay_to, token_total_raw, quote_expires_at, payment_request_id, eip712 } = quote
      if (await hook(structuredClone({
        requestId: id, payer, pay_to, token_total_raw, quote_expires_at, payment_request_id, eip712,
      })) !== true) throw new Error('Human approval declined')
    }
    const result = (state: Result['state'], order: Order, p?: Payment): Result => ({
      flow_id: order.flow_id, payment_request_id: order.payment_request_id, payment_url: order.payment_url,
      requestId: id, state, status: p?.status, status_reason: p?.status_reason,
      tx_signature: p?.payment?.tx_signature, attribution_verified: p?.attribution_verified === true,
    })

    if (!step) await record({ state: 'NEW' })
    // A fresh invocation of resume on a pending record gets a new ten-minute window.
    let pollStart = step?.state === 'PENDING_CONFIRMATION' ? this.clock.now() : undefined
    for (;;) {
      const s = step as Step
      switch (s.state) {
        case 'NEW': {
          if (s.createAttempted) throw new Error('Order creation outcome unknown; reconcile cart id ' + id)
          const config = await hsp.call('get_chain_config', {})
          if (this.clock.now() >= Date.parse(intent.terms.cartExpiry)) throw new Error('Cart expired')
          const asset = this.opts.selectAsset(config, structuredClone(intent.terms))
          const input = makeOrder(id, intent, asset)
          // If create succeeded but its reply was lost, creating again is unsafe.
          await record({ state: 'NEW', createAttempted: true })
          const order = await hsp.call('create_order', input)
          if (![order?.flow_id, order?.payment_request_id, order?.payment_url]
            .every(x => typeof x === 'string' && x)) throw new Error('Incomplete order response')
          await record({ state: 'ORDER_CREATED', order: { ...order, asset } })
          break
        }
        case 'ORDER_CREATED':
          await prepare(s.order)
          break
        case 'PREPARED':
        case 'APPROVED_SIGN':
        case 'SIGNED':
        case 'FINALIZED':
        case 'APPROVED_SUBMIT': {
          const { order, quote } = s
          if (expired(quote)) {
            await prepare(order, quote)
            break
          }
          if (s.state === 'PREPARED') {
            await approve(quote, this.opts.approveSign)
            await record({ state: 'APPROVED_SIGN', order, quote })
          } else if (s.state === 'APPROVED_SIGN') {
            const signature = await this.opts.signTypedData(structuredClone(quote.eip712))
            if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !await verifyTypedData({
              ...quote.eip712, address: quote.payer, signature,
            })) throw new Error('Invalid payer signature')
            await record({ state: 'SIGNED', order, quote, signature })
          } else if (s.state === 'SIGNED') {
            const { cart_hash, payment_payload, payment_mandate_contents } = quote
            const mandate = await hsp.call('finalize_payment', {
              signature: s.signature, cart_hash, payment_payload, payment_mandate_contents,
            })
            if (mandate?.payment_mandate_json == null) throw new Error('Missing finalized mandate')
            await record({ state: 'FINALIZED', order, quote, mandate })
          } else if (s.state === 'FINALIZED') {
            await approve(quote, this.opts.approveSubmit)
            await record({ ...s, state: 'APPROVED_SUBMIT' })
          } else if (s.state === 'APPROVED_SUBMIT') {
            const track = { order, quote, pollStarted: this.clock.now(), accepted: false }
            await record({ ...track, state: 'SUBMIT_INTENT' })
            if (expired(quote)) {
              await prepare(order, quote)
              break
            }
            let submitted
            try {
              submitted = await hsp.call('submit_payment', { payment_mandate_json: s.mandate.payment_mandate_json })
            } catch (error) {
              // For an ambiguous network error leave SUBMIT_INTENT durable for resume().
              if (!(error instanceof ToolError) || String(error.code) !== '30043') throw error
              // A synchronous 30043 definitively rejects this attempt. If we
              // crash after this record, resume still reconciles by query first.
              await record({ ...track, state: 'SUBMIT_INTENT', gatewayExpired: true })
              await prepare(order, quote)
              break
            }
            if (submitted?.status !== 'payment-submitted') throw new Error('Unknown submit outcome; resume')
            await record({ ...track, accepted: true, state: 'SUBMITTED' })
          }
          break
        }
        case 'SUBMIT_INTENT':
        case 'SUBMITTED':
        case 'PENDING_CONFIRMATION': {
          const started = pollStart ?? s.pollStarted
          pollStart = undefined
          const deadline = started + 600_000
          let accepted = s.accepted
          let observation = s.observation
          // During downtime the old window may have ended. Allow one bounded
          // reconciliation read, then return pending if still unresolved.
          let firstRead = true
          for (;;) {
            const before = this.clock.now()
            if (!firstRead && before >= deadline) {
              await record({ ...s, state: 'PENDING_CONFIRMATION', accepted, observation })
              return result('PENDING_CONFIRMATION', s.order, observation)
            }
            firstRead = false
            const timeout = before >= deadline ? 15_000 : Math.min(15_000, deadline - before)
            let payment: Payment | undefined
            try {
              const p = await hsp.call('query_payment', {
                flow_id: s.order.flow_id, expected_merchant_name: intent.terms.merchant,
              }, timeout)
              if (p && statuses.includes(p.status)) payment = p
            } catch (error) {
              if (!accepted && error instanceof ToolError && error.tool === 'query_payment' &&
                  (s.gatewayExpired || expired(s.quote)) && this.opts.isDefinitivelyAbsent?.(error)) {
                await prepare(s.order, s.quote)
                break
              }
              // A timeout, malformed answer, or transport error cannot authorize submission.
            }
            if (payment) {
              observation = payment
              accepted = true
              if (['payment-safe', 'payment-finalized', 'payment-failed'].includes(payment.status)) {
                const state = payment.status === 'payment-failed' ? 'FAILED' : 'CONFIRMED'
                await record({ state, order: s.order, observation: payment })
                return result(state, s.order, payment)
              }
              await record({ ...s, state: 'SUBMITTED', accepted, pollStarted: started, observation })
            }
            const remaining = deadline - this.clock.now()
            if (remaining > 0) {
              await this.clock.sleep(Math.min(remaining, Math.max(0, before + 15_000 - this.clock.now())))
            }
          }
          break
        }
        case 'CONFIRMED':
        case 'FAILED':
          return result(s.state, s.order, s.observation)
        default:
          throw new Error('Unknown journal state')
      }
    }
  }
}
