export interface PaymentTerms {
  sellerAgentId: string;
  payTo: `0x${string}`;
  amountUsd: string;
  item: string;
  itemVersionHash: `0x${string}`;
  expiresAt: string;
  whatYouLearn: string;
}

export interface PayIntent {
  buyerAgentId: string;
  terms: PaymentTerms;
  intentNonce: string;
}

export type PayState =
  | 'NEW' | 'ORDER_CREATED' | 'PREPARED' | 'APPROVED_SIGN' | 'SIGNED'
  | 'FINALIZED' | 'APPROVED_SUBMIT' | 'SUBMIT_INTENT' | 'SUBMITTED'
  | 'CONFIRMED' | 'FAILED' | 'PENDING_CONFIRMATION';

export interface PayRecord {
  requestId: `0x${string}`;
  state: PayState;
  flowId?: string;
  paymentRequestId?: string;
  submitCalls: number;
  history: { state: PayState; at: string; note?: string }[];
  txHash?: string;
}

export interface PayOnceApi {
  payOnce(intent: PayIntent): Promise<PayRecord>;
  get(requestId: `0x${string}`): Promise<PayRecord | undefined>;
  resumeAll(): Promise<PayRecord[]>;
}
