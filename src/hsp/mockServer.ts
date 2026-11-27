import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { keccak256, stringToHex, verifyTypedData } from 'viem'
import type { Address, Hex } from 'viem'
import { isObject, toolNames } from './types.js'
import type { Asset, CreateOrder, Order, Payment, Quote, Tool, ToolError, TypedMessage } from './types.js'

// Synthetic fixtures, local to this server. No chain connection.
export const mockAsset: Asset = {
  network: 'local-mock', chain_id: 31337,
  contract_address: '0x0000000000000000000000000000000000000001', coin: 'MOCK',
}
export function selectMockAsset(config: unknown): Asset {
  if (!isObject(config) || !Array.isArray(config.assets) || !isObject(config.assets[0])) {
    throw new Error('Invalid mock chain config')
  }
  return config.assets[0] as unknown as Asset
}
export const mockAbsent = (e: ToolError) => e.code === 'MOCK_NO_ACCEPTED_PAYMENT'

interface MockOrder extends Order {
  input: CreateOrder
  accepted: boolean
  queryIndex: number
}
export interface MockOptions {
  now?: () => number
  dropSubmitResponseOnce?: boolean
  submitDelayMs?: number
  rejectExpiredOnce?: boolean
  statuses?: Payment[]
  omitTool?: Tool
  onAccepted?: () => void
}
export async function startMock(options: MockOptions = {}) {
  const orders = new Map<string, MockOrder>()
  const quotes = new Map<string, Quote>()
  const mandates = new Map<string, { quote: Quote; signature: Hex }>()
  const now = options.now ?? Date.now
  const audit = {
    calls: [] as Tool[], submitCalls: 0, accepted: 0,
    signed: [] as Hex[], attemptedSignatures: [] as Hex[], acceptedSignatures: [] as Hex[],
    queries: [] as { flow_id: string; merchant: unknown; at: number }[],
    get orderCount() { return orders.size },
  }
  const statuses: Payment[] = options.statuses ?? [
    { status: 'payment-safe', payment: { tx_signature: 'mock-transaction' }, attribution_verified: false },
  ]
  if (!statuses.length) throw new Error('Empty query status sequence')
  const error = (code: string | number) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code }) }] })
  const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
  const findOrder = (args: Record<string, unknown>) => [...orders.values()].find(
    o => o.flow_id === args.flow_id || o.payment_request_id === args.payment_request_id,
  )
  async function dispatch(name: string, args: Record<string, unknown>, drop: () => void) {
    audit.calls.push(name as Tool)
    switch (name) {
      case 'get_chain_config': return ok({ assets: [mockAsset] })
      case 'estimate_fee': return ok({ mock: true })
      case 'create_order': {
        const input = args as unknown as CreateOrder
        const c = input.cart_mandate.contents
        const method = c.payment_request.method_data[0]
        if (!method || method.supported_methods !== 'https://www.x402.org/' ||
            !isDeepStrictEqual(method.data, { ...mockAsset, x402Version: 2, pay_to: input.pay_to }) ||
            input.merchant_name !== c.merchant_name || !c.id || !Number.isFinite(Date.parse(c.cart_expiry)) ||
            c.payment_request.details.total.amount.currency !== 'USD') return error('MOCK_INVALID_CART')
        const id = randomUUID()
        const order = { flow_id: 'flow-' + id, payment_request_id: 'request-' + id, payment_url: 'https://example.invalid/' + id }
        orders.set(order.flow_id, { ...order, input, accepted: false, queryIndex: 0 })
        return ok(order)
      }
      case 'get_order': return ok(findOrder(args) ?? null)
      case 'prepare_payment': {
        const o = findOrder(args)
        if (!o || o.accepted) return error('MOCK_ORDER_UNAVAILABLE')
        const payer = args.payer as Address
        const pay_to = o.input.pay_to
        const nonce = keccak256(stringToHex(randomUUID()))
        const expires = now() + 300_000
        const raw = '1000000'
        const domain = { name: 'MockToken', version: '1', chainId: mockAsset.chain_id, verifyingContract: mockAsset.contract_address }
        const eip712: TypedMessage = args.protocol === 'eip3009' ? {
          domain, primaryType: 'TransferWithAuthorization',
          types: { TransferWithAuthorization: [
            { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
          ] },
          message: { from: payer, to: pay_to, value: raw, validAfter: '0', validBefore: String(Math.floor(expires / 1000)), nonce },
        } : {
          domain: { ...domain, name: 'MockPermit2' }, primaryType: 'PermitTransferFrom',
          types: {
            TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
            PermitTransferFrom: [
              { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
              { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
            ],
          },
          message: { permitted: { token: mockAsset.contract_address, amount: raw }, spender: pay_to,
            nonce: BigInt(nonce).toString(), deadline: String(Math.floor(expires / 1000)) },
        }
        const quote: Quote = {
          cart_hash: keccak256(stringToHex(JSON.stringify(o.input.cart_mandate))),
          payment_request_id: o.payment_request_id, pay_to, payer, token_total_raw: raw,
          quote_expires_at: new Date(expires).toISOString(), eip712,
          payment_payload: { nonce, flow: o.flow_id }, payment_mandate_contents: { nonce, raw },
        }
        quotes.set(nonce, quote)
        return ok(quote)
      }
      case 'finalize_payment': {
        const payload = args.payment_payload
        const q = isObject(payload) && quotes.get(String(payload.nonce))
        const signature = args.signature as Hex
        if (!q || !isDeepStrictEqual(payload, q.payment_payload) || args.cart_hash !== q.cart_hash ||
            !isDeepStrictEqual(args.payment_mandate_contents, q.payment_mandate_contents) ||
            !await verifyTypedData({ ...q.eip712, address: q.payer, signature })) return error('MOCK_INVALID_AUTHORIZATION')
        audit.signed.push(signature)
        const json = JSON.stringify({ flow: payload.flow, signature, nonce: payload.nonce })
        mandates.set(json, { quote: q, signature })
        return ok({ payment_mandate_json: json })
      }
      case 'submit_payment': {
        audit.submitCalls++
        const m = mandates.get(String(args.payment_mandate_json))
        if (!m || Object.keys(args).length !== 1) return error('MOCK_INVALID_MANDATE')
        audit.attemptedSignatures.push(m.signature)
        if (options.rejectExpiredOnce || now() >= Date.parse(m.quote.quote_expires_at)) {
          options.rejectExpiredOnce = false
          return error(30043)
        }
        const o = findOrder({ payment_request_id: m.quote.payment_request_id })!
        o.accepted = true
        audit.accepted++
        audit.acceptedSignatures.push(m.signature)
        options.onAccepted?.()
        if (options.dropSubmitResponseOnce) {
          options.dropSubmitResponseOnce = false
          drop()
        }
        if (options.submitDelayMs) await new Promise(r => setTimeout(r, options.submitDelayMs))
        return ok({ status: 'payment-submitted' })
      }
      case 'query_payment': {
        const o = findOrder(args)
        if (!o || args.expected_merchant_name !== o.input.merchant_name) return error('MOCK_ORDER_OR_MERCHANT_MISMATCH')
        audit.queries.push({ flow_id: o.flow_id, merchant: args.expected_merchant_name, at: now() })
        if (!o.accepted) return error('MOCK_NO_ACCEPTED_PAYMENT')
        return ok(statuses[Math.min(o.queryIndex++, statuses.length - 1)])
      }
      default: return error('MOCK_UNKNOWN_TOOL')
    }
  }
  const server = createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(405).end(); return }
    const mcp = new Server({ name: 'local-hsp-mock', version: '1.0.0' }, { capabilities: { tools: {} } })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolNames.filter(n => n !== options.omitTool).map(name => ({
        name, inputSchema: { type: 'object' as const, additionalProperties: true },
      })),
    }))
    mcp.setRequestHandler(CallToolRequestSchema, async req =>
      dispatch(req.params.name, req.params.arguments ?? {}, () => res.destroy()))
    res.once('close', () => { void mcp.close() })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    } catch { res.destroy() }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing mock port')
  return {
    url: `http://localhost:${address.port}/mcp`, audit,
    async close() {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    },
  }
}
