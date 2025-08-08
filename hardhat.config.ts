import '@nomicfoundation/hardhat-ethers';
import { HardhatUserConfig } from 'hardhat/types';

const ONINO_MAINNET_URL = 'https://rpc.onino.io';
const PRIVATE_KEY = '...'; // Add your actual deployment private key here

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
    onino: {
      url: ONINO_MAINNET_URL,
      accounts: [PRIVATE_KEY],
    },
  },
};

export default config;
