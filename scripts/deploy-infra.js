/**
 * File: scripts/deploy-infrastructure.js
 *
 * This Hardhat script performs all one-time deployments for the T-REX ecosystem.
 * It deploys the complete infrastructure needed to create ERC-3643 security tokens.
 *
 * DEPLOYMENT FLOW:
 *   1) Core T-REX Logic Implementations (6 contracts) - Business logic for all tokens
 *   2) OnchainID Infrastructure (3 contracts) - Identity management system
 *   3) Compliance Modules (11 contracts) - Pluggable compliance rules
 *   4) TREXImplementationAuthority - Registry for T-REX logic versions
 *   5) TREXFactory - Creates new token suites using the above infrastructure
 *   6) TREXFactoryGateway - Access control wrapper around TREXFactory
 *   7) Final Setup - Authorize factory and transfer ownership
 *
 * DEPENDENCIES:
 *   - Steps 1-3 are independent and can run in parallel
 *   - Step 4 depends on Step 1 (needs T-REX implementations)
 *   - Step 5 depends on Steps 2 & 4 (needs IdFactory + TREXImplementationAuthority)
 *   - Step 6 depends on Step 5 (wraps TREXFactory)
 *   - Step 7 depends on Steps 5 & 6 (configures factory relationships)
 *
 * OUTPUTS:
 *   - All contract addresses saved to `deployments/<network>-infrastructure.json`
 *   - This file is used by token deployment scripts and frontend applications
 *
 * Usage:
 *   - Configure your networks in hardhat.config.js (e.g. "localhost" or "onino")
 *   - Create a .env file if you need to supply private keys or RPC URLs
 *   - Run: `npx hardhat run --network <network> scripts/deploy-infrastructure.js`
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

// Convert from file:// URL to a file system path
const filename = fileURLToPath(import.meta.url);
// Recreate __dirname exactly as in CommonJS
const dirname = path.dirname(filename);

const network = {
  name: 'onino',
};

// 1. Fetch deployer account (first signer from Hardhat)
const [deployer] = await ethers.getSigners();
const deployerAddress = await deployer.getAddress();
console.log(`\n🚀 Deploying T-REX infrastructure on network "${network.name}"`);
console.log(`    Deployer Address: ${deployerAddress}\n`);

// Helper function: deploys a contract by name with optional constructor args
async function deployContract(name, args = []) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`    → ${name} deployed at: ${address}`);
  return address;
}

/** ***********************************
 * STEP 1: Deploy Core T-REX Logic Implementations
 *
 * These 6 contracts contain the business logic for all T-REX tokens.
 * They are deployed once and reused by all token suites via proxy pattern.
 * Each new token gets its own set of proxies that delegate to these implementations.
 ************************************ */

console.log('🔨 Deploying T-REX logic implementations (one-time)...');

// ClaimTopicsRegistry Implementation
// PURPOSE: Manages "claim topics" (e.g., KYC=1, AML=2) required for token holders
// USAGE: Each token's ClaimTopicsRegistryProxy delegates to this logic
// DEPENDENCIES: None (standalone logic contract)
const claimTopicsRegistryImpl = await deployContract('ClaimTopicsRegistry');

// TrustedIssuersRegistry Implementation
// PURPOSE: Stores which entities can issue identity claims and for which topics
// USAGE: Each token's TrustedIssuersRegistryProxy delegates to this logic
// DEPENDENCIES: None (standalone logic contract)
const trustedIssuersRegistryImpl = await deployContract('TrustedIssuersRegistry');

// IdentityRegistryStorage Implementation
// PURPOSE: Manages wallet ↔ OnchainID mappings for verified users
// USAGE: Each token's IdentityRegistryStorageProxy delegates to this logic
// DEPENDENCIES: None (standalone logic contract)
const identityRegistryStorageImpl = await deployContract('IdentityRegistryStorage');

// IdentityRegistry Implementation
// PURPOSE: Core identity verification logic - checks claims, manages user registry
// USAGE: Each token's IdentityRegistryProxy delegates to this logic
// DEPENDENCIES: Works with ClaimTopicsRegistry, TrustedIssuersRegistry, IdentityRegistryStorage
const identityRegistryImpl = await deployContract('IdentityRegistry');

// ModularCompliance Implementation
// PURPOSE: Manages compliance modules that enforce transfer rules
// USAGE: Each token's ModularComplianceProxy delegates to this logic
// DEPENDENCIES: Works with compliance modules deployed in Step 3
const modularComplianceImpl = await deployContract('ModularCompliance');

// Token Implementation (ERC-3643)
// PURPOSE: Core security token logic - transfers, minting, compliance checks
// USAGE: Each token's TokenProxy delegates to this logic
// DEPENDENCIES: Works with IdentityRegistry and ModularCompliance
const tokenImpl = await deployContract('Token');

/** ***********************************
 * STEP 2: Deploy OnchainID Infrastructure
 *
 * OnchainID is the identity layer that manages user identities and claims.
 * This creates the factory system for deploying user and token identities.
 * Dependencies: None (independent of T-REX logic)
 ************************************ */

console.log('\n🔒 Deploying OnchainID (Identity) logic and authority...');

// 1) Identity Logic Contract
// PURPOSE: Core OnchainID logic - manages keys, claims, and identity operations
// CONSTRUCTOR: Identity(trustedAuthority: address, initialManager: bool)
//   - trustedAuthority: address of deployer (will be updated to ImplementationAuthority)
//   - initialManager: true = deployer gets initial management key
// USAGE: All IdentityProxy contracts delegate to this implementation
const IdentityLogicFactory = await ethers.getContractFactory('Identity');
const identityLogic = await IdentityLogicFactory.deploy(deployerAddress, true);
await identityLogic.waitForDeployment();
const identityLogicAddress = await identityLogic.getAddress();
console.log(`    → Identity (OnchainID) logic deployed at: ${identityLogicAddress}`);

// 2) IdentityImplementationAuthority
// PURPOSE: Registry that holds the current Identity logic address
// CONSTRUCTOR: ImplementationAuthority(identityImplementation: address)
//   - identityImplementation: address of Identity logic contract above
// USAGE: IdentityProxy contracts read this to find current logic implementation
// DEPENDENCIES: Requires Identity logic address from step 1
const IdentityImplAuthFactory = await ethers.getContractFactory('ImplementationAuthority');

const identityImplAuth = await IdentityImplAuthFactory.deploy(identityLogicAddress);
await identityImplAuth.waitForDeployment();
const identityImplAuthAddress = await identityImplAuth.getAddress();
console.log(`    → IdentityImplementationAuthority deployed at: ${identityImplAuthAddress}`);

// 3) IdFactory (OnchainID Factory)
// PURPOSE: Creates new IdentityProxy instances for users and tokens
// CONSTRUCTOR: IdFactory(implementationAuthority: address)
//   - implementationAuthority: address of IdentityImplementationAuthority above
// USAGE: Called by TREXFactory to create token identities, and by users to create personal identities
// DEPENDENCIES: Requires IdentityImplementationAuthority from step 2
const idFactoryAddr = await deployContract('IdFactory', [identityImplAuthAddress]);

/** ***********************************
 * STEP 3: Deploy Compliance Modules
 *
 * Compliance modules are pluggable contracts that enforce specific business rules.
 * They are deployed once and can be reused across multiple tokens.
 * Each token can mix and match modules based on regulatory requirements.
 * Dependencies: None (standalone rule enforcement contracts)
 ************************************ */

console.log('\n📋 Deploying Compliance Modules...');
const complianceModules = {};

// Deploy all available compliance modules
// These modules implement the IModule interface and can be bound to ModularCompliance contracts
// Each module enforces specific compliance rules during token transfers
const moduleNames = [
  'TransferRestrictModule', // Block/allow specific addresses from transferring
  'ConditionalTransferModule', // Complex conditional transfer logic
  'CountryAllowModule', // Whitelist specific countries (by ISO code)
  'CountryRestrictModule', // Blacklist specific countries (by ISO code)
  'MaxBalanceModule', // Limit maximum token balance per holder
  'SupplyLimitModule', // Limit total token supply
  'TimeTransfersLimitsModule', // Time-based transfer limits per holder
  'TimeExchangeLimitsModule', // Time-based limits for exchange transfers
  'ExchangeMonthlyLimitsModule', // Monthly limits for exchange transfers
  'TransferFeesModule', // Collect fees on transfers
  'TokenListingRestrictionsModule', // Control which tokens investors can receive
];

// Deploy each compliance module
// PURPOSE: Each module contains specific compliance logic that can be bound to tokens
// USAGE: Token deployers specify which modules to use in their compliance configuration
// PATTERN: All modules follow the same deployment pattern (no constructor args)
for (let i = 0; i < moduleNames.length; i += 1) {
  const moduleName = moduleNames[i];
  const module = await ethers.deployContract(moduleName, [], deployer);
  await module.waitForDeployment();
  /* complianceModules[moduleName] = {
    address: module.target,
    abi: module.interface.fragments,
  }; */
  complianceModules[moduleName] = module.target;
  console.log(`    → ${moduleName} deployed at:`, module.target);
}

/** ***********************************
 * STEP 4: Deploy TREXImplementationAuthority
 *
 * This registry manages versions of T-REX implementations and provides upgrade paths.
 * It stores the addresses of all 6 T-REX logic contracts as a versioned set.
 * The TREXFactory reads from this to know which implementations to use for new tokens.
 * Dependencies: Requires T-REX implementations from Step 1
 ************************************ */

console.log('\n🛠  Deploying TREXImplementationAuthority...');

// TREXImplementationAuthority Contract
// PURPOSE: Version registry for T-REX implementations - enables upgrades
// CONSTRUCTOR: TREXImplementationAuthority(publicDeployment: bool, initialFactory: address, placeholder: address)
//   - publicDeployment: true = allows public access (vs restricted to specific factories)
//   - initialFactory: address(0) = no initial factory restriction
//   - placeholder: address(0) = reserved parameter for future use
// USAGE: TREXFactory queries this to get current implementation addresses
// DEPENDENCIES: Will be populated with implementations from Step 1
const trexImplAuthAddr = await deployContract('TREXImplementationAuthority', [
  true, // publicDeployment = true (allow public access)
  '0x0000000000000000000000000000000000000000', // no initial factory restriction
  '0x0000000000000000000000000000000000000000', // placeholder parameter
]);

console.log(`    → TREXImplementationAuthority deployed at: ${trexImplAuthAddr}`);

// Register T-REX Implementation Version 1.0.0
// PURPOSE: Store the 6 T-REX implementation addresses as version 1.0.0
// PROCESS: Bundle all implementations into a struct and register them
// RESULT: TREXFactory can now query for "version 1.0.0" and get all implementation addresses
const trexImplAuth = await ethers.getContractAt('TREXImplementationAuthority', trexImplAuthAddr);

const version = {
  major: 1,
  minor: 0,
  patch: 0,
};

const contractsStruct = {
  tokenImplementation: tokenImpl, // From Step 1
  ctrImplementation: claimTopicsRegistryImpl, // From Step 1
  irImplementation: identityRegistryImpl, // From Step 1
  irsImplementation: identityRegistryStorageImpl, // From Step 1
  tirImplementation: trustedIssuersRegistryImpl, // From Step 1
  mcImplementation: modularComplianceImpl, // From Step 1
};

console.log('    • Registering T-REX version 1.0.0 with implementation addresses...');
console.log('    • Implementation bundle:', contractsStruct);

const addAndUseTREXVersionTx = await trexImplAuth.addAndUseTREXVersion(version, contractsStruct);
const addAndUseTREXVersionReceipt = await addAndUseTREXVersionTx.wait();
console.log('    → Registration transaction:', addAndUseTREXVersionReceipt.hash);

console.log('    ✓ T-REX version 1.0.0 registered and set as current version');

// Verify the registration worked correctly
const contractsRes = await trexImplAuth.getContracts(version);
console.log('    → Verification - Retrieved contracts for v1.0.0:', contractsRes);

const versionRes = await trexImplAuth.getCurrentVersion();
console.log('    → Verification - Current version:', versionRes);

/** ***********************************
 * STEP 5: Deploy TREXFactory
 *
 * The factory contract that creates complete T-REX token suites.
 * It deploys 6 proxy contracts per token, each pointing to the implementations from Step 1.
 * It also creates OnchainID identities for tokens using the IdFactory from Step 2.
 * Dependencies: Requires TREXImplementationAuthority (Step 4) and IdFactory (Step 2)
 ************************************ */

console.log('\n🏭 Deploying TREXFactory...');

// TREXFactory Contract
// PURPOSE: Deploys complete token suites (6 proxies + token identity) in one transaction
// CONSTRUCTOR: TREXFactory(trexImplementationAuthority: address, identityFactory: address)
//   - trexImplementationAuthority: where to find current T-REX implementation addresses
//   - identityFactory: where to create new token identities (OnchainIDs)
// USAGE: Called by TREXFactoryGateway to deploy new security tokens
// PROCESS: For each token, deploys TokenProxy, IdentityRegistryProxy, ModularComplianceProxy,
//          ClaimTopicsRegistryProxy, TrustedIssuersRegistryProxy, IdentityRegistryStorageProxy
// DEPENDENCIES: Requires both TREXImplementationAuthority and IdFactory
console.log('    • TREXFactory constructor parameters:');
console.log(`      - TREXImplementationAuthority: ${trexImplAuthAddr}`);
console.log(`      - IdFactory: ${idFactoryAddr}`);

const trexFactoryAddr = await deployContract('TREXFactory', [trexImplAuthAddr, idFactoryAddr]);

// Authorize TREXFactory in IdFactory
// PURPOSE: Grant TREXFactory permission to create token identities
// PROCESS: IdFactory.addTokenFactory(TREXFactory address)
// REASON: IdFactory restricts who can create identities - only authorized factories allowed
// RESULT: TREXFactory can now call IdFactory.createTokenIdentity() for new tokens
const idFactoryContract = await ethers.getContractAt('IdFactory', idFactoryAddr);
console.log('    • Authorizing TREXFactory to create token identities...');
await idFactoryContract.addTokenFactory(trexFactoryAddr);
console.log('    ✓ TREXFactory is now authorized to create token identities via IdFactory');

/** ***********************************
 * STEP 6: Deploy TREXFactoryGateway
 *
 * Access control wrapper around TREXFactory that manages permissions and fees.
 * Provides public deployment controls, fee collection, and deployer whitelisting.
 * All token deployments go through this gateway rather than calling TREXFactory directly.
 * Dependencies: Requires TREXFactory from Step 5
 ************************************ */

console.log('\n🔑 Deploying TREXFactoryGateway...');

// TREXGateway Contract
// PURPOSE: Access control and fee management layer for token deployments
// CONSTRUCTOR: TREXGateway(factory: address, publicDeploymentStatus: bool)
//   - factory: address of TREXFactory to wrap
//   - publicDeploymentStatus: true = anyone can deploy, false = only whitelisted deployers
// FEATURES: Deployer whitelisting, deployment fees, batch deployments
// USAGE: Frontend applications call this contract to deploy tokens
// DEPENDENCIES: Requires TREXFactory address from Step 5
const trexGatewayAddr = await deployContract('TREXGateway', [
  trexFactoryAddr, // TREXFactory address from Step 5
  true, // publicDeploymentStatus = true (allow public deployments)
]);

/** ***********************************
 * STEP 7: Final Setup - Transfer Ownership and Configure Access
 *
 * Transfer TREXFactory ownership to the Gateway for security.
 * This ensures all deployments go through proper access controls.
 * Dependencies: Requires both TREXFactory (Step 5) and TREXGateway (Step 6)
 ************************************ */

console.log('\n🔐 Configuring final access controls...');

// Transfer TREXFactory Ownership to Gateway
// PURPOSE: Ensure all token deployments go through access-controlled gateway
// PROCESS: TREXFactory.transferOwnership(TREXGateway address)
// REASON: TREXFactory.deployTREXSuite() has onlyOwner modifier
// RESULT: Only TREXGateway can call TREXFactory.deployTREXSuite()
// SECURITY: Prevents direct calls to factory, enforces gateway controls
const trexFactory = await ethers.getContractAt('TREXFactory', trexFactoryAddr);
console.log('    • Transferring TREXFactory ownership to TREXGateway...');
await trexFactory.transferOwnership(trexGatewayAddr);
console.log('    ✓ TREXFactory ownership transferred - all deployments now go through Gateway');

/** ***********************************
 * FINAL: Save All Deployed Addresses
 *
 * Write all contract addresses to a JSON file for use by:
 * - Token deployment scripts
 * - Frontend applications
 * - Integration tests
 * - Contract verification scripts
 ************************************ */

console.log('\n💾 Saving all deployed addresses...');

// Create comprehensive address registry
// This file becomes the "phonebook" for the entire T-REX ecosystem
const deploymentsDir = path.join(dirname, '..', 'deployments');
if (!fs.existsSync(deploymentsDir)) {
  fs.mkdirSync(deploymentsDir);
}

// Organize addresses by category for easy consumption
const deployedAddresses = {
  // Core business logic contracts (Step 1)
  // These are the implementation contracts that all tokens delegate to
  implementations: {
    ClaimTopicsRegistry: claimTopicsRegistryImpl, // Manages required claim topics
    TrustedIssuersRegistry: trustedIssuersRegistryImpl, // Manages trusted claim issuers
    IdentityRegistryStorage: identityRegistryStorageImpl, // Stores identity mappings
    IdentityRegistry: identityRegistryImpl, // Core identity verification logic
    ModularCompliance: modularComplianceImpl, // Manages compliance modules
    Token: tokenImpl, // Core ERC-3643 token logic
    IdentityLogic: identityLogicAddress, // OnchainID logic contract
  },

  // Authority/registry contracts (Steps 2 & 4)
  // These manage versions and provide upgrade paths
  authorities: {
    IdentityImplementationAuthority: identityImplAuthAddress, // OnchainID version registry
    TREXImplementationAuthority: trexImplAuthAddr, // T-REX version registry
  },

  // Factory contracts (Steps 2 & 5 & 6)
  // These create new instances of tokens and identities
  factories: {
    IdentityFactory: idFactoryAddr, // Creates OnchainID instances
    TREXFactory: trexFactoryAddr, // Creates T-REX token suites
    TREXFactoryGateway: trexGatewayAddr, // Access-controlled factory wrapper
  },

  // Compliance modules (Step 3)
  // These enforce specific business rules and can be mixed/matched per token
  complianceModules: complianceModules,

  // Deployment metadata
  network: network.name,
  timestamp: new Date().toISOString(),
  deployer: deployerAddress,
};

const filePath = path.join(deploymentsDir, `deployed-trex-infrastructure.json`);
fs.writeFileSync(filePath, JSON.stringify(deployedAddresses, null, 2));
console.log(`    → Complete address registry saved to: ${filePath}`);

console.log('\n✅ T-REX Infrastructure Deployment Complete!');
console.log('\n📋 Summary:');
console.log(`    • 6 T-REX implementations deployed and registered as v1.0.0`);
console.log(`    • 3 OnchainID contracts deployed (logic + authority + factory)`);
console.log(`    • ${moduleNames.length} compliance modules deployed`);
console.log(`    • TREXFactory deployed and authorized`);
console.log(`    • TREXGateway deployed with public access enabled`);
console.log(`    • All contracts ready for token deployments`);
console.log(`\n🚀 Ready to deploy security tokens using the TREXGateway at: ${trexGatewayAddr}`);
