import type { Address } from 'viem'
import { mockAsset } from '../src/hsp/mockServer.js'
import type { Intent } from '../src/payOnce.js'

export function mockIntent(buyer: Address, now: number): Intent {
  return {
    buyer, seller: '0x0000000000000000000000000000000000000002', intentId: 'example-1',
    terms: {
      merchant: 'Local demo team', label: 'Demo item', usd: '1.00',
      cartExpiry: new Date(now + 7_200_000).toISOString(),
      network: mockAsset.network, token: mockAsset.contract_address, protocol: 'eip3009',
    },
  }
}
