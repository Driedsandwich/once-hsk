import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAddress } from 'viem';
import { createSellerServer, type VerifyPayment } from './server.js';

const payTo = process.env.PAY_TO;
if (!payTo || !isAddress(payTo)) throw new Error('Set PAY_TO to the public recipient address.');
const adapter = process.env.ONCE_VERIFIER;
let verifyPayment: VerifyPayment = async () => false;
if (adapter) {
  const module = await import(pathToFileURL(resolve(adapter)).href);
  if (typeof module.verifyPayment !== 'function') throw new Error('Adapter must export verifyPayment.');
  verifyPayment = module.verifyPayment;
}
const port = Number(process.env.PORT ?? '3001');
createSellerServer({ payTo, verifyPayment }).listen(port, '127.0.0.1', () => {
  console.error(`Pool Data Agent listening on http://127.0.0.1:${port}/a2a`);
});
