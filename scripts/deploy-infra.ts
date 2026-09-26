/**
 * One-time deployment of the T-REX (ERC-3643) infrastructure on a network.
 *
 * Deployment flow:
 *   1) T-REX logic implementations (Token, IR, IRS, TIR, CTR, MC)
 *   2) ONCHAINID suite (Identity implementation, ImplementationAuthority, IdFactory) from `@onchain-id/solidity`
 *   3) TREXImplementationAuthority (reference IA) + registration of the implementations as the current T-REX version
 *   4) TREXFactory + authorization on the IdFactory + wiring on the reference IA
 *   5) IAFactory (required by `changeImplementationAuthority` to deploy auxiliary IAs for tokens)
 *   6) TREXGateway, which becomes owner of the TREXFactory
 *   7) Optional: whitelisting of gateway deployers and ownership transfer to the final owner
 *
 * Every deployed address and executed configuration transaction is persisted right away in
 * `deployments/<network>.json`. Re-running the script on the same network resumes from that file:
 * contracts that are already deployed and configuration steps that are already applied on-chain are skipped.
 *
 * Environment variables (all optional):
 *   TREX_VERSION               version registered on the IA, e.g. "4.1.3" (default: version from package.json)
 *   GATEWAY_PUBLIC_DEPLOYMENT  "true" | "false" - anyone may deploy a suite for themselves via the gateway (default: "true")
 *   GATEWAY_DEPLOYERS          comma-separated addresses allowed to deploy suites on behalf of other owners
 *   TREX_OWNER                 address receiving ownership of the IA, IdFactory, Identity IA and gateway at the end
 *   CONFIRMATIONS              block confirmations to wait for on each transaction (default: 1)
 *
 * Usage:
 *   npx hardhat run --network <network> scripts/deploy-infra.ts
 *   DEPLOYER_PRIVATE_KEY=0x... npm run deploy:infra -- --network onino   (RPC overridable with ONINO_RPC_URL)
 */
import fs from 'fs';
import path from 'path';
import hre, { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';
import { Contract, ContractFactory, ContractTransaction } from 'ethers';

type Version = { major: number; minor: number; patch: number };

type DeploymentRecord = {
  network: string;
  chainId: number;
  deployer: string;
  trexVersion: Version;
  implementations: Record<string, string>;
  authorities: Record<string, string>;
  factories: Record<string, string>;
  transactions: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

type Section = 'implementations' | 'authorities' | 'factories';

const DEPLOYMENTS_DIR = path.join(__dirname, '..', 'deployments');

function parseVersion(value: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid TREX_VERSION "${value}", expected <major>.<minor>.<patch>`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
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
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const networkName = hre.network.name;

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const trexVersion = parseVersion(process.env.TREX_VERSION ?? packageJson.version);
  const publicDeployment = (process.env.GATEWAY_PUBLIC_DEPLOYMENT ?? 'true').toLowerCase() === 'true';
  const gatewayDeployers = parseAddresses(process.env.GATEWAY_DEPLOYERS);
  const finalOwner = process.env.TREX_OWNER ? ethers.utils.getAddress(process.env.TREX_OWNER) : undefined;
  const confirmations = Number(process.env.CONFIRMATIONS ?? 1);

  const recordPath = path.join(DEPLOYMENTS_DIR, `${networkName}.json`);
  const now = new Date().toISOString();
  let record: DeploymentRecord = {
    network: networkName,
    chainId,
    deployer: deployer.address,
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
    if (existing.chainId !== chainId) {
      throw new Error(`${recordPath} belongs to chain ${existing.chainId}, connected to chain ${chainId}`);
    }
    if (!sameVersion(existing.trexVersion, trexVersion)) {
      throw new Error(
        `${recordPath} was created for T-REX version ${Object.values(existing.trexVersion).join('.')}, ` +
          'move it away to deploy a new infrastructure',
      );
    }
    const recorded = [existing.implementations, existing.authorities, existing.factories].flatMap((section) => Object.entries(section));
    const codes = await Promise.all(recorded.map(([, address]) => ethers.provider.getCode(address)));
    const missing = recorded.find((_, index) => codes[index] === '0x');
    if (missing) {
      throw new Error(`${recordPath} is stale: no code for ${missing[0]} at ${missing[1]} (chain reset?), remove the file to redeploy`);
    }
    record = existing;
    console.log(`Resuming deployment from ${recordPath}`);
  }

  const save = () => {
    record.updatedAt = new Date().toISOString();
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  };

  // Deploys a contract, or attaches to the one already recorded.
  const deploy = async (section: Section, key: string, factory: ContractFactory, args: unknown[] = []): Promise<Contract> => {
    const recorded = record[section][key];
    if (recorded) {
      console.log(`  = ${key} already deployed at ${recorded}`);
      return factory.attach(recorded);
    }
    const contract = await factory.deploy(...args);
    await contract.deployTransaction.wait(confirmations);
    record[section][key] = contract.address;
    save();
    console.log(`  + ${key} deployed at ${contract.address}`);
    return contract;
  };

  // Sends a configuration transaction unless `isDone` reports it as already applied.
  const step = async (key: string, isDone: () => Promise<boolean>, send: () => Promise<ContractTransaction>) => {
    if (await isDone()) {
      console.log(`  = ${key} already applied`);
      return;
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
  console.log(`Deployer: ${deployer.address} (balance ${ethers.utils.formatEther(await deployer.getBalance())})\n`);

  console.log('1) T-REX implementations');
  const tokenImplementation = await deploy('implementations', 'Token', await local('Token'));
  const ctrImplementation = await deploy('implementations', 'ClaimTopicsRegistry', await local('ClaimTopicsRegistry'));
  const irImplementation = await deploy('implementations', 'IdentityRegistry', await local('IdentityRegistry'));
  const irsImplementation = await deploy('implementations', 'IdentityRegistryStorage', await local('IdentityRegistryStorage'));
  const tirImplementation = await deploy('implementations', 'TrustedIssuersRegistry', await local('TrustedIssuersRegistry'));
  const mcImplementation = await deploy('implementations', 'ModularCompliance', await local('ModularCompliance'));

  console.log('\n2) ONCHAINID');
  // Identity(initialManagementKey, isLibrary): deployed as library, only used as implementation by IdentityProxy.
  const identityImplementation = await deploy('implementations', 'Identity', onchainId('Identity'), [deployer.address, true]);
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
    () => idFactory.isTokenFactory(trexFactory.address),
    () => idFactory.addTokenFactory(trexFactory.address),
  );
  await step(
    'TREXImplementationAuthority.setTREXFactory',
    async () => sameAddress(await trexImplementationAuthority.getTREXFactory(), trexFactory.address),
    () => trexImplementationAuthority.setTREXFactory(trexFactory.address),
  );

  console.log('\n5) IAFactory');
  const iaFactory = await deploy('factories', 'IAFactory', await local('IAFactory'), [trexFactory.address]);
  // The IA exposes no getter for its IAFactory, the recorded transaction is the source of truth.
  await step(
    'TREXImplementationAuthority.setIAFactory',
    async () => Boolean(record.transactions['TREXImplementationAuthority.setIAFactory']),
    () => trexImplementationAuthority.setIAFactory(iaFactory.address),
  );

  console.log('\n6) TREXGateway');
  const trexGateway = await deploy('factories', 'TREXGateway', await local('TREXGateway'), [trexFactory.address, publicDeployment]);
  // TREXFactory.deployTREXSuite is onlyOwner: all suites are deployed through the gateway.
  await step(
    'TREXFactory.transferOwnership',
    async () => sameAddress(await trexFactory.owner(), trexGateway.address),
    () => trexFactory.transferOwnership(trexGateway.address),
  );

  console.log('\n7) Access control');
  const isDeployer = await Promise.all(gatewayDeployers.map((address) => trexGateway.isDeployer(address)));
  const newDeployers = gatewayDeployers.filter((_, index) => !isDeployer[index]);
  await step(
    'TREXGateway.batchAddDeployer',
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
            async () => sameAddress(await contract.owner(), finalOwner),
            () => contract.transferOwnership(finalOwner),
          ),
        ),
      Promise.resolve(),
    );
  } else {
    console.log('  TREX_OWNER not set, ownership left unchanged');
  }

  console.log(`\nDeployment record: ${recordPath}`);
  console.log(`TREXGateway (entry point for token suite deployments): ${trexGateway.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
