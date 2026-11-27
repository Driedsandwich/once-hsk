import { describe, expect, it } from 'vitest';
import { decide } from '../src/buyer/decide.js';
import { intent, now } from './support/fixtures.js';

const { terms } = intent;
const inflow = '1h inflow (USD)';
const outflow = '1h outflow (USD)';

describe('Research Agent', () => {
  it('skips a purchase when local data answers the question, including zero', () => {
    expect(decide([inflow], { [inflow]: 0 }, terms, now)).toEqual({ action: 'skip', reason: 'already-known' });
  });

  it('requests human approval when every missing field is offered', () => {
    const decision = decide([inflow, outflow], { [outflow]: 40, [inflow]: null }, terms, now);
    expect(decision.action).toBe('request-approval');
    if (decision.action === 'request-approval') {
      expect(decision.missing).toEqual([inflow]);
      for (const text of [terms.payTo, terms.sellerAgentId, '0.50 USD', terms.whatYouLearn]) {
        expect(decision.approvalText).toContain(text);
      }
    }
  });

  it('skips an offer that only partially answers the question', () => {
    expect(decide([inflow, '1h fees (USD)'], {}, terms, now))
      .toEqual({ action: 'skip', reason: 'incomplete-offer' });
  });

  it('skips an offer at its expiration time', () => {
    expect(decide([outflow], {}, terms, Date.parse(terms.expiresAt))).toEqual({ action: 'skip', reason: 'expired' });
  });
});
