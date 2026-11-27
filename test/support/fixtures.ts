import { isDeepStrictEqual } from 'node:util';
import { keccak256, stringToHex } from 'viem';
import type { PayIntent, PayRecord, PayOnceApi } from '../../src/types.js';

export const now = Date.parse('2026-10-01T00:00:00.000Z');
export const payTo = '0x0000000000000000000000000000000000000001';
export const intent: PayIntent = {
  buyerAgentId: 'Research Agent', intentNonce: 'order-7',
  terms: {
    sellerAgentId: 'Pool Data Agent', payTo, amountUsd: '0.50', item: 'HSKSwap 1h flow report',
    itemVersionHash: keccak256(stringToHex('test-version')), expiresAt: new Date(now + 600_000).toISOString(),
    whatYouLearn: '1h inflow (USD), 1h outflow (USD)'
  }
};

export const record: PayRecord = {
  requestId: keccak256(stringToHex('test-request')), state: 'PREPARED', submitCalls: 0,
  history: [{ state: 'PREPARED', at: new Date(now).toISOString() }]
};

// Used by the CLI transport tests. Differences in any input are observable by the client.
export const payOnceApi: PayOnceApi = {
  async payOnce(value) {
    if (!isDeepStrictEqual(value, intent)) throw new Error('Unexpected test intent');
    return record;
  },
  async get(requestId) { return requestId === record.requestId ? record : undefined; },
  async resumeAll() { return [record]; }
};
