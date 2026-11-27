const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');

// Resolve the pinned npm compiler, including on a machine without a compiler cache.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _hre, runSuper) => {
  if (solcVersion !== '0.8.24') return runSuper();
  return {
    compilerPath: require.resolve('solc/soljson.js'),
    isSolcJs: true,
    version: solcVersion,
    longVersion: require('solc').version()
  };
});

module.exports = {
  solidity: { version: '0.8.24', settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 } } },
  networks: { hardhat: { accounts: [] } },
  paths: { tests: './contracts-test' }
};
