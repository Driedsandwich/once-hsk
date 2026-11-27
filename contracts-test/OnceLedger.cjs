const assert = require('node:assert/strict');
const { network, artifacts } = require('hardhat');
const {
  createPublicClient, createWalletClient, custom, parseEther, toHex, keccak256,
  stringToHex, encodeAbiParameters, parseEventLogs, encodeFunctionData, toFunctionSelector, zeroHash
} = require('viem');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { hardhat } = require('viem/chains');

describe('OnceLedger', function () {
  const provider = network.provider;
  const transport = custom(provider);
  const reader = createPublicClient({ chain: hardhat, transport });
  const requestId = keccak256(stringToHex('research-order'));
  const termsHash = keccak256(stringToHex('fixture-terms'));
  const settlementHash = keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'bytes32' }], ['test-flow', keccak256(stringToHex('fixture-tx'))]
  ));
  let abi, ledger, owner, other;

  async function wallet() {
    const account = privateKeyToAccount(generatePrivateKey());
    await provider.send('hardhat_setBalance', [account.address, toHex(parseEther('1'))]);
    return createWalletClient({ account, chain: hardhat, transport });
  }

  beforeEach(async function () {
    owner = await wallet();
    other = await wallet();
    const artifact = await artifacts.readArtifact('OnceLedger');
    abi = artifact.abi;
    const hash = await owner.deployContract({ abi, bytecode: artifact.bytecode });
    ledger = (await reader.waitForTransactionReceipt({ hash })).contractAddress;
  });

  async function write(functionName, value) {
    const hash = await owner.writeContract({ address: ledger, abi, functionName, args: [requestId, value] });
    return reader.waitForTransactionReceipt({ hash });
  }

  async function expectRevert(caller, functionName, value, errorName) {
    const data = encodeFunctionData({ abi, functionName, args: [requestId, value] });
    await assert.rejects(
      provider.send('eth_call', [{ from: caller.account.address, to: ledger, data }, 'latest']),
      error => error.data === toFunctionSelector(errorName + '()')
    );
  }

  it('returns both block timestamps, the registrar and hashes, and emits both events', async function () {
    const registration = await write('register', termsHash);
    const settlement = await write('markSettled', settlementHash);
    const entry = await reader.readContract({ address: ledger, abi, functionName: 'get', args: [requestId] });
    const blockTime = receipt => reader.getBlock({ blockNumber: receipt.blockNumber }).then(b => b.timestamp);
    assert.deepEqual(entry, [owner.account.address, termsHash, settlementHash,
      await blockTime(registration), await blockTime(settlement)]);
    const event = receipt => parseEventLogs({ abi, logs: receipt.logs })[0];
    assert.equal(event(registration).eventName, 'Registered');
    assert.deepEqual(event(registration).args, { requestId, registrar: owner.account.address, termsHash });
    assert.equal(event(settlement).eventName, 'Settled');
    assert.deepEqual(event(settlement).args, { requestId, settlementHash });
  });

  it('rejects another registration even from another account', async function () {
    await write('register', termsHash);
    await expectRevert(other, 'register', zeroHash, 'AlreadyRegistered');
  });

  it('rejects settlement by another account', async function () {
    await write('register', termsHash);
    await expectRevert(other, 'markSettled', settlementHash, 'NotRegistrar');
  });

  it('rejects a second settlement even after a zero hash', async function () {
    await write('register', termsHash);
    await write('markSettled', zeroHash);
    await expectRevert(owner, 'markSettled', settlementHash, 'AlreadySettled');
  });
});
