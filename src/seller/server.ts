import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { getAddress, keccak256, stringToHex, type Address } from 'viem';
import { z } from 'zod';
import type { PaymentTerms } from '../types.js';

export const item = 'HSKSwap 1h flow report';
const report = Object.freeze({
  item,
  notice: 'Sample values for the demo (not real market data)',
  '1h inflow (USD)': '125.00',
  '1h outflow (USD)': '40.00'
});
const itemVersionHash = keccak256(stringToHex(JSON.stringify(report)));

export type Offer = Omit<PaymentTerms, 'expiresAt'>;
export interface PaymentClaim {
  buyerAgentId: string;
  flowId: string;
  expected: Readonly<Offer>;
}
export type VerifyPayment = (claim: PaymentClaim) => Promise<boolean>;

const envelope = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  params: z.unknown().optional()
});
const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('quote'), item: z.literal(item) }),
  z.object({ action: z.literal('paid'), buyerAgentId: z.string().trim().min(1), flowId: z.string().trim().min(1) })
]);
const params = z.object({ message: z.object({
  kind: z.literal('message'),
  role: z.literal('user'),
  messageId: z.string().min(1),
  parts: z.tuple([z.object({ kind: z.literal('data'), data: action })])
}) });

class BodyTooLarge extends Error {}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 64 * 1024) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createSellerServer(options: {
  payTo: Address;
  verifyPayment: VerifyPayment;
  now?: () => number;
}) {
  const offer: Readonly<Offer> = Object.freeze({
    sellerAgentId: 'Pool Data Agent',
    payTo: getAddress(options.payTo),
    amountUsd: '0.50',
    item,
    itemVersionHash,
    whatYouLearn: '1h inflow (USD), 1h outflow (USD)'
  });
  const now = options.now ?? Date.now;
  return createServer(async (req, res) => {
    if (req.url !== '/a2a') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }

    let id: string | number | null | undefined = null;
    function reply(payload: object, status = 200) {
      if (id === undefined) { res.writeHead(204).end(); return; }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
    }
    function fail(code: number, message: string, status = 200) {
      reply({ error: { code, message } }, status);
    }

    let body: unknown;
    try { body = await readJson(req); }
    catch (error) {
      if (error instanceof BodyTooLarge) fail(-32600, 'Request too large', 413);
      else fail(-32700, 'Parse error', 400);
      return;
    }
    const rpc = envelope.safeParse(body);
    if (!rpc.success) return fail(-32600, 'Invalid request');
    id = rpc.data.id;
    if (rpc.data.method !== 'message/send') return fail(-32601, 'Method not found');
    const parsed = params.safeParse(rpc.data.params);
    if (!parsed.success) return fail(-32602, 'Invalid message or item');
    const request = parsed.data.message.parts[0].data;

    let data: object;
    if (request.action === 'quote') {
      const expiresAt = new Date(now() + 10 * 60_000).toISOString();
      data = { ...offer, expiresAt } satisfies PaymentTerms;
    } else {
      // Only the verifier has access to the authoritative, dated payment receipt.
      try {
        const paid = await options.verifyPayment({
          buyerAgentId: request.buyerAgentId, flowId: request.flowId, expected: offer
        });
        if (paid !== true) return fail(-32001, 'Payment not confirmed');
      } catch {
        return fail(-32002, 'Payment verification unavailable');
      }
      data = report;
    }
    reply({ result: { kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'data', data }] } });
  });
}
