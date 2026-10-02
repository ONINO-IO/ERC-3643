import 'dotenv/config';
import '@xyrusworx/hardhat-solidity-json';
import '@nomicfoundation/hardhat-toolbox';
import { HardhatUserConfig } from 'hardhat/config';
import '@openzeppelin/hardhat-upgrades';
import 'solidity-coverage';
import '@nomiclabs/hardhat-solhint';
import '@primitivefi/hardhat-dodoc';

// Deployment target for scripts/deploy-infra.ts (settings in .env, see .env.example), only defined when RPC_URL is set
// so it never falls back to another chain. The deployer key is read by the script itself (hardhat vars), not here.
const { RPC_URL } = process.env;

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.17',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    ...(RPC_URL ? { target: { url: RPC_URL } } : {}),
  },
  gasReporter: {
    enabled: true,
  },
  dodoc: {
    runOnCompile: false,
    debugMode: true,
    outputDir: "./docgen",
    freshOutput: true,
  },
};

export default config;
