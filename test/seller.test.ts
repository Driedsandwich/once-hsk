import type { Server } from 'node:http';
import { keccak256, stringToHex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSellerServer, item, type VerifyPayment } from '../src/seller/server.js';
import { now, payTo } from './support/fixtures.js';
import { close, listen } from './support/http.js';

let server: Server;
let url: string;
async function start(verifyPayment: VerifyPayment) {
  server = createSellerServer({ payTo, verifyPayment, now: () => now });
  url = await listen(server) + '/a2a';
}
afterEach(async () => { if (server?.listening) await close(server); });

function envelope(data: object) {
  return {
    jsonrpc: '2.0', id: 'r-1', method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId: 'buyer-message', parts: [{ kind: 'data', data }] } }
  };
}
async function post(body: string) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  return response.json();
}
const send = (data: object) => post(JSON.stringify(envelope(data)));
const quote = { action: 'quote', item };
const claim = { action: 'paid', buyerAgentId: 'Research Agent', flowId: 'fixture-paid-flow' };

describe('Pool Data Agent over HTTP', () => {
  it('quotes ten minutes at USD 0.50 and releases the matching report after verification', async () => {
    const verify = vi.fn<VerifyPayment>().mockResolvedValue(true);
    await start(verify);
    const first = await send(quote);
    expect(first).toMatchObject({ jsonrpc: '2.0', id: 'r-1', result: { kind: 'message', role: 'agent' } });
    expect(first.result.messageId).toBeTruthy();
    const terms = first.result.parts[0].data;
    expect(terms).toEqual({
      sellerAgentId: 'Pool Data Agent', payTo, amountUsd: '0.50', item,
      itemVersionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), expiresAt: new Date(now + 600_000).toISOString(),
      whatYouLearn: '1h inflow (USD), 1h outflow (USD)'
    });
    expect(verify).not.toHaveBeenCalled();
    const second = await send(claim);
    const report = second.result.parts[0].data;
    const { expiresAt: _, ...expected } = terms;
    expect(verify.mock.calls).toEqual([[{ flowId: claim.flowId, buyerAgentId: claim.buyerAgentId, expected }]]);
    expect(report.notice).toBe('Sample values for the demo (not real market data)');
    for (const field of terms.whatYouLearn.split(',').map((s: string) => s.trim())) expect(report[field]).toBeDefined();
    expect(keccak256(stringToHex(JSON.stringify(report)))).toBe(terms.itemVersionHash);
  });

  it('withholds data for a denied flow even when the buyer includes a paid flag', async () => {
    const verify = vi.fn<VerifyPayment>().mockResolvedValue(false);
    await start(verify);
    await send(quote);
    expect(await send({ ...claim, confirmed: true })).toEqual({
      jsonrpc: '2.0', id: 'r-1', error: { code: -32001, message: 'Payment not confirmed' }
    });
    expect(verify).toHaveBeenCalledOnce();
  });

  it('withholds the report when a confirmed receipt belongs to a different product version', async () => {
    const receipt = { flowId: claim.flowId, buyerAgentId: claim.buyerAgentId, version: keccak256(stringToHex('older report')) };
    await start(async ({ flowId, buyerAgentId, expected }) =>
      receipt.flowId === flowId && receipt.buyerAgentId === buyerAgentId && receipt.version === expected.itemVersionHash
    );
    expect(await send(claim)).toEqual({
      jsonrpc: '2.0', id: 'r-1', error: { code: -32001, message: 'Payment not confirmed' }
    });
  });

  it('returns only a generic error if verification fails', async () => {
    await start(async () => { throw new Error('private verifier detail'); });
    expect(await send(claim)).toEqual({
      jsonrpc: '2.0', id: 'r-1', error: { code: -32002, message: 'Payment verification unavailable' }
    });
  });

  it('rejects an empty flowId before consulting the verifier', async () => {
    const verify = vi.fn<VerifyPayment>();
    await start(verify);
    expect(await send({ ...claim, flowId: ' ' })).toEqual({
      jsonrpc: '2.0', id: 'r-1', error: { code: -32602, message: 'Invalid message or item' }
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns JSON-RPC errors for malformed JSON and unknown methods', async () => {
    await start(async () => false);
    expect(await post('{')).toMatchObject({ id: null, error: { code: -32700 } });
    expect(await post(JSON.stringify({ ...envelope(quote), method: 'unknown' })))
      .toMatchObject({ id: 'r-1', error: { code: -32601 } });
  });
});
