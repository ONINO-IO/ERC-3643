/**
 * One-time deployment of the T-REX (ERC-3643) infrastructure on a chain.
 *
 * Deployment flow:
 *   1) T-REX logic implementations (Token, IR, IRS, TIR, CTR, MC) and the ONCHAINID Identity implementation, sent in parallel
 *   2) ONCHAINID ImplementationAuthority and IdFactory from `@onchain-id/solidity`
 *   3) TREXImplementationAuthority (reference IA) + registration of the implementations as the current T-REX version
 *   4) TREXFactory + authorization on the IdFactory + wiring on the reference IA
 *   5) IAFactory (required by `changeImplementationAuthority` to deploy auxiliary IAs for tokens)
 *   6) TREXGateway, which becomes owner of the TREXFactory
 *   7) Gateway deployer whitelist and optional ownership transfer to the final owner
 *
 * Output, one self-contained folder per chain to copy into the platform repository:
 *   deployments/<chainId>/deployment.json   address, deploy block and deploy tx of every contract + config txs
 *   deployments/<chainId>/abis/<Name>.json  ABI of every deployed contract, plus ClaimIssuer and IdentityProxy
 * The record is written after every transaction. Re-running the script on the same chain resumes from it:
 * contracts already deployed and configuration already applied on-chain are skipped.
 *
 * Secrets (hardhat configuration variables, never pass them inline on the command line):
 *   npx hardhat vars set DEPLOYER_PRIVATE_KEY      prompts for the key, remove it afterwards with `npx hardhat vars delete`
 *   On hardhat/localhost the first local account is used when the variable is not set.
 *
 * Environment variables:
 *   RPC_URL                    RPC endpoint of the `target` network (required for --network target)
 *   EXPECTED_CHAIN_ID          chain id the RPC must report (required outside hardhat/localhost)
 *   TREX_VERSION               version registered on the IA, e.g. "4.1.3" (default: version from package.json)
 *   GATEWAY_PUBLIC_DEPLOYMENT  "true" | "false" - anyone may deploy a suite for themselves via the gateway (default: "false")
 *   GATEWAY_DEPLOYERS          comma-separated addresses allowed to deploy suites via the gateway, e.g. the platform backend
 *   TREX_OWNER                 address receiving ownership of the IA, IdFactory, Identity IA and gateway at the end
 *   CONFIRMATIONS              block confirmations to wait for on each transaction, >= 1 (default: 1)
 *
 * Step-by-step guide: docs/DEPLOYMENT.md
 *
 * Usage:
 *   RPC_URL=https://... EXPECTED_CHAIN_ID=1234 npm run deploy:infra
 *   npx hardhat run --network localhost scripts/deploy-infra.ts
 */
import fs from 'fs';
import path from 'path';
import hre, { ethers } from 'hardhat';
import { vars } from 'hardhat/config';
import OnchainID from '@onchain-id/solidity';
import { Contract, ContractFactory, ContractTransaction, Signer, Wallet } from 'ethers';

type Version = { major: number; minor: number; patch: number };

type DeployedContract = {
  address: string;
  blockNumber: number;
  transactionHash: string;
  bytecodeHash: string;
};

type DeploymentRecord = {
  network: string;
  chainId: number;
  deployer: string;
  trexVersion: Version;
  implementations: Record<string, DeployedContract>;
  authorities: Record<string, DeployedContract>;
  factories: Record<string, DeployedContract>;
  transactions: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

type Section = 'implementations' | 'authorities' | 'factories';

type DeployItem = { section: Section; key: string; factory: ContractFactory; args?: unknown[] };

const LOCAL_NETWORKS = ['hardhat', 'localhost'];
// Gas used by a full run (about 29M on a local node) with a safety margin, checked against the balance before a fresh run.
const GAS_BUDGET = 35_000_000;

function parseVersion(value: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid TREX_VERSION "${value}", expected <major>.<minor>.<patch>`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function parseBoolean(name: string, defaultValue: boolean): boolean {
  const value = (process.env[name] ?? String(defaultValue)).trim().toLowerCase();
  if (value !== 'true' && value !== 'false') {
    throw new Error(`Invalid ${name} "${process.env[name]}", expected "true" or "false"`);
  }
  return value === 'true';
}

function parseAddresses(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.length > 0)
    .map((address) => ethers.utils.getAddress(address))
    .filter((address, index, all) => all.indexOf(address) === index);
}

function sameVersion(a: Version, b: Version): boolean {
  return Number(a.major) === b.major && Number(a.minor) === b.minor && Number(a.patch) === b.patch;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function main() {
  const networkName = hre.network.name;
  const isLocal = LOCAL_NETWORKS.includes(networkName);
  const { chainId } = await ethers.provider.getNetwork();

  if (!isLocal) {
    const expectedChainId = process.env.EXPECTED_CHAIN_ID;
    if (!expectedChainId) {
      throw new Error('EXPECTED_CHAIN_ID is required outside hardhat/localhost');
    }
    if (Number(expectedChainId) !== chainId) {
      throw new Error(`RPC reports chain ${chainId}, EXPECTED_CHAIN_ID is ${expectedChainId}`);
    }
  }

  let deployer: Signer;
  if (vars.has('DEPLOYER_PRIVATE_KEY')) {
    deployer = new Wallet(vars.get('DEPLOYER_PRIVATE_KEY'), ethers.provider);
  } else if (isLocal) {
    [deployer] = await ethers.getSigners();
  } else {
    throw new Error('DEPLOYER_PRIVATE_KEY is not set, run `npx hardhat vars set DEPLOYER_PRIVATE_KEY`');
  }
  const deployerAddress = await deployer.getAddress();

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const trexVersion = parseVersion(process.env.TREX_VERSION ?? packageJson.version);
  const publicDeployment = parseBoolean('GATEWAY_PUBLIC_DEPLOYMENT', false);
  const gatewayDeployers = parseAddresses(process.env.GATEWAY_DEPLOYERS);
  const finalOwner = process.env.TREX_OWNER ? ethers.utils.getAddress(process.env.TREX_OWNER) : undefined;
  const confirmations = Number(process.env.CONFIRMATIONS ?? 1);
  if (!Number.isInteger(confirmations) || confirmations < 1) {
    throw new Error(`Invalid CONFIRMATIONS "${process.env.CONFIRMATIONS}", expected an integer >= 1`);
  }

  const outputDir = path.join(__dirname, '..', 'deployments', String(chainId));
  const recordPath = path.join(outputDir, 'deployment.json');
  const now = new Date().toISOString();
  let record: DeploymentRecord = {
    network: networkName,
    chainId,
    deployer: deployerAddress,
    trexVersion,
    implementations: {},
    authorities: {},
    factories: {},
    transactions: {},
    createdAt: now,
    updatedAt: now,
  };
  // The in-process hardhat network starts empty on every run, a previous record can never be resumed there.
  if (networkName !== 'hardhat' && fs.existsSync(recordPath)) {
    const existing: DeploymentRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (!sameVersion(existing.trexVersion, trexVersion)) {
      throw new Error(
        `${recordPath} was created for T-REX version ${Object.values(existing.trexVersion).join('.')}, ` +
          'move it away to deploy a new infrastructure',
      );
    }
    if (!sameAddress(existing.deployer, deployerAddress)) {
      throw new Error(`${recordPath} was deployed by ${existing.deployer}, resume it with that key (current: ${deployerAddress})`);
    }
    const recorded = [existing.implementations, existing.authorities, existing.factories].flatMap((section) => Object.entries(section));
    const codes = await Promise.all(recorded.map(([, contract]) => ethers.provider.getCode(contract.address)));
    const missing = recorded.find((_, index) => codes[index] === '0x');
    if (missing) {
      throw new Error(`${recordPath} is stale: no code for ${missing[0]} at ${missing[1].address} (chain reset?), remove it to redeploy`);
    }
    record = existing;
    console.log(`Resuming deployment from ${recordPath}`);
  }

  const balance = await deployer.getBalance();
  const gasPrice = await ethers.provider.getGasPrice();
  const budget = gasPrice.mul(GAS_BUDGET);
  if (balance.lt(budget)) {
    const message = `Deployer balance ${ethers.utils.formatEther(balance)} is below the estimated ${ethers.utils.formatEther(budget)} needed`;
    const isFresh = Object.keys(record.implementations).length === 0;
    if (isFresh) throw new Error(message);
    console.warn(`Warning: ${message} for a full run`);
  }

  const save = () => {
    record.updatedAt = new Date().toISOString();
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  };

  const abis: Record<string, ContractFactory['interface']> = {};

  // Deploys the given contracts, sent back-to-back with explicit nonces and confirmed together.
  // Contracts already recorded are attached instead, provided their bytecode matches the current artifacts.
  const deployAll = async (items: DeployItem[]): Promise<Contract[]> => {
    const pending = items.filter(({ section, key }) => !record[section][key]);
    let nonce = await deployer.getTransactionCount('pending');
    const sent: Contract[] = [];
    // Sequential sends: each needs the next nonce, only the confirmations are awaited in parallel.
    await pending.reduce(
      (previous, { factory, args = [] }) =>
        previous.then(async () => {
          sent.push(await factory.deploy(...args, { nonce }));
          nonce += 1;
        }),
      Promise.resolve(),
    );
    await Promise.all(
      pending.map(async ({ section, key, factory }, index) => {
        const receipt = await sent[index].deployTransaction.wait(confirmations);
        record[section][key] = {
          address: sent[index].address,
          blockNumber: receipt.blockNumber,
          transactionHash: receipt.transactionHash,
          bytecodeHash: ethers.utils.keccak256(factory.bytecode),
        };
        save();
        console.log(`  + ${key} deployed at ${sent[index].address}`);
      }),
    );
    return items.map(({ section, key, factory }) => {
      const deployed = record[section][key];
      if (deployed.bytecodeHash !== ethers.utils.keccak256(factory.bytecode)) {
        throw new Error(`${key} at ${deployed.address} was deployed from different bytecode than the current artifacts`);
      }
      if (!pending.some((item) => item.key === key)) {
        console.log(`  = ${key} already deployed at ${deployed.address}`);
      }
      abis[key] = factory.interface;
      return factory.attach(deployed.address);
    });
  };
  const deploy = async (section: Section, key: string, factory: ContractFactory, args: unknown[] = []) =>
    (await deployAll([{ section, key, factory, args }]))[0];

  // Sends a configuration transaction unless `isDone` reports it as already applied.
  // `owned` is the contract whose owner has to send it, checked up front for a clear error instead of a revert.
  const step = async (key: string, owned: Contract, isDone: () => Promise<boolean>, send: () => Promise<ContractTransaction>) => {
    if (await isDone()) {
      console.log(`  = ${key} already applied`);
      return;
    }
    const owner = await owned.owner();
    if (!sameAddress(owner, deployerAddress)) {
      throw new Error(`${key}: ${owned.address} is owned by ${owner}, not by the deployer ${deployerAddress}; apply it as the owner`);
    }
    const receipt = await (await send()).wait(confirmations);
    record.transactions[key] = receipt.transactionHash;
    save();
    console.log(`  + ${key} (tx ${receipt.transactionHash})`);
  };

  const local = (name: string) => ethers.getContractFactory(name, deployer);
  const onchainId = (name: keyof typeof OnchainID.contracts) =>
    new ContractFactory(OnchainID.contracts[name].abi, OnchainID.contracts[name].bytecode, deployer);

  console.log(`Deploying T-REX ${Object.values(trexVersion).join('.')} infrastructure on "${networkName}" (chain ${chainId})`);
  console.log(`Deployer: ${deployerAddress} (balance ${ethers.utils.formatEther(balance)})\n`);

  console.log('1) Implementations');
  const [tokenImplementation, ctrImplementation, irImplementation, irsImplementation, tirImplementation, mcImplementation, identityImplementation] =
    await deployAll([
      { section: 'implementations', key: 'Token', factory: await local('Token') },
      { section: 'implementations', key: 'ClaimTopicsRegistry', factory: await local('ClaimTopicsRegistry') },
      { section: 'implementations', key: 'IdentityRegistry', factory: await local('IdentityRegistry') },
      { section: 'implementations', key: 'IdentityRegistryStorage', factory: await local('IdentityRegistryStorage') },
      { section: 'implementations', key: 'TrustedIssuersRegistry', factory: await local('TrustedIssuersRegistry') },
      { section: 'implementations', key: 'ModularCompliance', factory: await local('ModularCompliance') },
      // Identity(initialManagementKey, isLibrary): deployed as library, only used as implementation by IdentityProxy.
      { section: 'implementations', key: 'Identity', factory: onchainId('Identity'), args: [deployerAddress, true] },
    ]);

  console.log('\n2) ONCHAINID');
  const identityImplementationAuthority = await deploy('authorities', 'IdentityImplementationAuthority', onchainId('ImplementationAuthority'), [
    identityImplementation.address,
  ]);
  const idFactory = await deploy('factories', 'IdFactory', onchainId('Factory'), [identityImplementationAuthority.address]);

  console.log('\n3) TREXImplementationAuthority');
  // Reference IA: TREXFactory and IAFactory do not exist yet and are set once deployed.
  const trexImplementationAuthority = await deploy('authorities', 'TREXImplementationAuthority', await local('TREXImplementationAuthority'), [
    true,
    ethers.constants.AddressZero,
    ethers.constants.AddressZero,
  ]);
  const trexContracts = {
    tokenImplementation: tokenImplementation.address,
    ctrImplementation: ctrImplementation.address,
    irImplementation: irImplementation.address,
    irsImplementation: irsImplementation.address,
    tirImplementation: tirImplementation.address,
    mcImplementation: mcImplementation.address,
  };
  await step(
    'addAndUseTREXVersion',
    trexImplementationAuthority,
    async () => sameVersion(await trexImplementationAuthority.getCurrentVersion(), trexVersion),
    () => trexImplementationAuthority.addAndUseTREXVersion(trexVersion, trexContracts),
  );
  const registered = await trexImplementationAuthority.getContracts(trexVersion);
  Object.entries(trexContracts).forEach(([key, address]) => {
    if (!sameAddress(registered[key], address)) {
      throw new Error(`IA registered ${key}=${registered[key]} for this version, expected ${address}`);
    }
  });

  console.log('\n4) TREXFactory');
  const trexFactory = await deploy('factories', 'TREXFactory', await local('TREXFactory'), [trexImplementationAuthority.address, idFactory.address]);
  await step(
    'IdFactory.addTokenFactory',
    idFactory,
    () => idFactory.isTokenFactory(trexFactory.address),
    () => idFactory.addTokenFactory(trexFactory.address),
  );
  await step(
    'TREXImplementationAuthority.setTREXFactory',
    trexImplementationAuthority,
    async () => sameAddress(await trexImplementationAuthority.getTREXFactory(), trexFactory.address),
    () => trexImplementationAuthority.setTREXFactory(trexFactory.address),
  );

  console.log('\n5) IAFactory');
  const iaFactory = await deploy('factories', 'IAFactory', await local('IAFactory'), [trexFactory.address]);
  // The IA exposes no getter for its IAFactory, the last IAFactorySet event holds the current value.
  await step(
    'TREXImplementationAuthority.setIAFactory',
    trexImplementationAuthority,
    async () => {
      const events = await trexImplementationAuthority.queryFilter(
        trexImplementationAuthority.filters.IAFactorySet(),
        record.authorities.TREXImplementationAuthority.blockNumber,
      );
      const last = events[events.length - 1];
      return last !== undefined && sameAddress(last.args?.iaFactory, iaFactory.address);
    },
    () => trexImplementationAuthority.setIAFactory(iaFactory.address),
  );

  console.log('\n6) TREXGateway');
  const trexGateway = await deploy('factories', 'TREXGateway', await local('TREXGateway'), [trexFactory.address, publicDeployment]);
  await step(
    'TREXGateway.setPublicDeploymentStatus',
    trexGateway,
    async () => (await trexGateway.getPublicDeploymentStatus()) === publicDeployment,
    () => trexGateway.setPublicDeploymentStatus(publicDeployment),
  );
  // TREXFactory.deployTREXSuite is onlyOwner: all suites are deployed through the gateway.
  await step(
    'TREXFactory.transferOwnership',
    trexFactory,
    async () => sameAddress(await trexFactory.owner(), trexGateway.address),
    () => trexFactory.transferOwnership(trexGateway.address),
  );

  console.log('\n7) Access control');
  const isDeployer = await Promise.all(gatewayDeployers.map((address) => trexGateway.isDeployer(address)));
  const newDeployers = gatewayDeployers.filter((_, index) => !isDeployer[index]);
  await step(
    'TREXGateway.batchAddDeployer',
    trexGateway,
    async () => newDeployers.length === 0,
    () => trexGateway.batchAddDeployer(newDeployers),
  );

  if (finalOwner) {
    const owned: [string, Contract][] = [
      ['TREXImplementationAuthority', trexImplementationAuthority],
      ['IdentityImplementationAuthority', identityImplementationAuthority],
      ['IdFactory', idFactory],
      ['TREXGateway', trexGateway],
    ];
    // Sequential on purpose: steps share the deployer nonce and the record file.
    await owned.reduce(
      (previous, [name, contract]) =>
        previous.then(() =>
          step(
            `${name}.transferOwnership`,
            contract,
            async () => sameAddress(await contract.owner(), finalOwner),
            () => contract.transferOwnership(finalOwner),
          ),
        ),
      Promise.resolve(),
    );
  } else {
    console.log('  TREX_OWNER not set, ownership left unchanged');
  }

  // ABIs of the deployed contracts, plus the ONCHAINID contracts the platform deploys per issuer / investor.
  abis.ClaimIssuer = onchainId('ClaimIssuer').interface;
  abis.IdentityProxy = onchainId('IdentityProxy').interface;
  const abiDir = path.join(outputDir, 'abis');
  fs.mkdirSync(abiDir, { recursive: true });
  Object.entries(abis).forEach(([name, contractInterface]) => {
    const abi = JSON.parse(contractInterface.format(ethers.utils.FormatTypes.json) as string);
    fs.writeFileSync(path.join(abiDir, `${name}.json`), `${JSON.stringify(abi, null, 2)}\n`);
  });

  console.log(`\nDeployment record and ABIs: ${outputDir}`);
  console.log(`TREXGateway (entry point for token suite deployments): ${trexGateway.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
