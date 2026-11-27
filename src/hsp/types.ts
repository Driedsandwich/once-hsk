import type { Address, Hex, TypedData, TypedDataDomain } from 'viem'

export type Protocol = 'eip3009' | 'permit2'
export interface Asset {
  network: string
  chain_id: number
  contract_address: Address
  coin: string
}
export interface CreateOrder {
  merchant_name: string
  pay_to: Address
  cart_mandate: {
    contents: {
      id: string
      merchant_name: string
      cart_expiry: string
      user_cart_confirmation_required: boolean
      payment_request: {
        method_data: {
          supported_methods: 'https://www.x402.org/'
          data: Asset & { x402Version: 2; pay_to: Address }
        }[]
        details: {
          id: string
          total: { label: string; amount: { currency: 'USD'; value: string } }
          display_items?: unknown[]
        }
      }
    }
  }
}
export interface Order {
  flow_id: string
  payment_request_id: string
  payment_url: string
}
export interface TypedMessage {
  domain: TypedDataDomain
  types: TypedData
  primaryType: string
  message: Record<string, unknown>
}
export interface Quote {
  eip712: TypedMessage
  cart_hash: string
  token_total_raw: string
  quote_expires_at: string
  pay_to: Address
  payer: Address
  payment_request_id: string
  payment_payload: unknown
  payment_mandate_contents: unknown
}
export interface Finalize extends Pick<Quote, 'payment_payload' | 'payment_mandate_contents' | 'cart_hash'> {
  signature: Hex
}
export interface Mandate { payment_mandate_json: unknown }
export const statuses = [
  'payment-submitted', 'payment-verified', 'payment-processing', 'payment-included',
  'payment-timeout', 'payment-safe', 'payment-finalized', 'payment-failed',
] as const
export type PaymentStatus = typeof statuses[number]
export interface Payment {
  status: PaymentStatus
  status_reason?: unknown
  payment?: { tx_signature?: string } | null
  attribution_verified?: boolean
}
type Identifier = { flow_id: string; payment_request_id?: never } |
  { flow_id?: never; payment_request_id: string }

interface ToolMap {
  get_chain_config: [Record<string, unknown>, unknown]
  create_order: [CreateOrder, Order]
  get_order: [Record<string, unknown>, unknown]
  prepare_payment: [{ flow_id: string; payer: Address; protocol: Protocol }, Quote]
  finalize_payment: [Finalize, Mandate]
  estimate_fee: [Record<string, unknown>, unknown]
  submit_payment: [Mandate, { status: 'payment-submitted' }]
  query_payment: [Identifier & { expected_merchant_name: string }, Payment]
}
export type Tool = keyof ToolMap
export type Input<K extends Tool> = ToolMap[K][0]
export type Output<K extends Tool> = ToolMap[K][1]
export const toolNames = [
  'get_chain_config', 'create_order', 'get_order', 'prepare_payment',
  'finalize_payment', 'estimate_fee', 'submit_payment', 'query_payment',
] as const satisfies readonly Tool[]
export interface Hsp {
  call<K extends Tool>(tool: K, input: Input<K>, timeoutMs?: number): Promise<Output<K>>
}
export function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}
export class ToolError extends Error {
  constructor(readonly tool: Tool, readonly detail: unknown) {
    super(`HSP tool error (${tool})`)
  }
  get code(): unknown {
    if (!isObject(this.detail)) return undefined
    return isObject(this.detail.error) ? this.detail.error.code : this.detail.code
  }
}
