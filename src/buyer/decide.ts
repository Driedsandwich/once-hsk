import type { PaymentTerms } from '../types.js';

export type Decision =
  | { action: 'skip'; reason: 'already-known' | 'incomplete-offer' | 'expired' }
  | { action: 'request-approval'; missing: string[]; approvalText: string };

// requiredFields are the data fields needed to answer this specific question.
export function decide(
  requiredFields: readonly string[],
  local: Readonly<Record<string, unknown>>,
  terms: PaymentTerms,
  nowMs: number
): Decision {
  const missing = [...new Set(requiredFields)].filter(field =>
    !Object.hasOwn(local, field) || local[field] == null || local[field] === ''
  );
  if (missing.length === 0) return { action: 'skip', reason: 'already-known' };

  const offered = new Set(terms.whatYouLearn.split(/[,、]/u).map(field => field.trim()));
  if (!missing.every(field => offered.has(field))) return { action: 'skip', reason: 'incomplete-offer' };
  if (!(Date.parse(terms.expiresAt) > nowMs)) return { action: 'skip', reason: 'expired' };
  return {
    action: 'request-approval',
    missing,
    approvalText: [
      `Buy "${terms.item}"?`,
      `Pay to: ${terms.sellerAgentId} (${terms.payTo})`,
      `Amount: ${terms.amountUsd} USD`,
      `What you learn: ${terms.whatYouLearn}`
    ].join('\n')
  };
}
