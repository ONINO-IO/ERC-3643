# Deploying the T-REX infrastructure to an EVM chain

One-time setup per chain: deploys the T-REX factory infrastructure (implementations, ONCHAINID, factory, gateway) with
`scripts/deploy-infra.ts`, then hands the addresses and ABIs to the tokenization platform. Examples use **Polygon PoS mainnet**.

**If a run is interrupted** (RPC error, Ctrl+C, low balance), fix the cause and run the same command again.
The script resumes where it stopped and never sends a transaction twice.

## What you get, and who controls it

| Contract | Role | Owner after deployment |
| --- | --- | --- |
| `TREXGateway` | Entry point: issuers / the platform deploy token suites here (`deployTREXSuite`) | admin |
| `TREXFactory` | Creates the token suites, only callable through the gateway | gateway |
| `TREXImplementationAuthority` | Holds the token logic version **of every token deployed through this factory** | admin |
| `IdFactory`, `IdentityImplementationAuthority` | ONCHAINID identities for tokens and investors | admin |

The **admin** is `TREX_OWNER` if set, otherwise the deployer wallet.

> ⚠️ The admin can upgrade the logic of all tokens created via this factory. Treat the admin key like a production key:
> keep it in your password manager / on a hardware wallet. Move ownership to a multisig later by re-running with `TREX_OWNER`
> (see [Later changes](#later-changes)).

---

## 0. Prerequisites (once per machine)

Node.js ≥ 18 and git.

```bash
git clone https://github.com/ONINO-IO/ERC-3643.git && cd ERC-3643
npm ci
npx hardhat compile        # must end with "Compiled ... successfully" or "Nothing to compile"
```

`npm ci` warnings (deprecated packages, vulnerabilities) and `punycode` warnings can be ignored.

## 1. Configure the chain

```bash
cp .env.example .env
```

Open `.env` in any editor and fill it in. The file explains each value, and it never gets committed.

| Setting | Meaning | Polygon example |
| --- | --- | --- |
| `RPC_URL` | RPC endpoint of the chain. A paid provider (Alchemy, Infura, QuickNode, dRPC) is more reliable than public ones | `https://polygon-bor-rpc.publicnode.com` (`polygon-rpc.com` is currently disabled) |
| `EXPECTED_CHAIN_ID` | Chain id, see [chainlist.org](https://chainlist.org). The script refuses to run on any other chain | `137` |
| `GATEWAY_PUBLIC_DEPLOYMENT` | `true` = open factory, every issuer can deploy a token suite for itself | `true` |
| `GATEWAY_DEPLOYERS` | Optional. Wallets that deploy **on behalf of** issuers (token owner ≠ sender), e.g. the platform backend | empty |
| `TREX_OWNER` | Optional. Admin wallet that receives ownership. Empty = deployer wallet stays admin | empty |
| `CONFIRMATIONS` | Blocks to wait per transaction | `3` |

## 2. Deployer wallet

1. Create a new account (MetaMask: account menu → **Add account**) and export its private key
   (**⋮ → Account details → Show private key**). Without `TREX_OWNER` this account becomes the admin, so store the key safely.
2. Store the key for the script. You are prompted for it, and the input is masked:
   ```bash
   npx hardhat vars set DEPLOYER_PRIVATE_KEY
   ```
   Never put the key into `.env` or a command line.

## 3. Dry run (free, sends nothing)

```bash
npm run deploy:dry-run
```

This simulates the full deployment with your `.env` settings. It must end with
`Dry run on the in-process hardhat network finished` and a `TREXGateway` address.
`invalid address` / `bad address checksum` means an address in `.env` is wrong.

## 4. Fund and deploy

```bash
npm run deploy:infra
```

The script checks the chain and the balance, then shows a summary:

```
About to send REAL transactions:
  Chain              137 via polygon-bor-rpc.publicnode.com
  Deployer           0x1234… (balance 20.0, ~9.69 needed)
  TREX_OWNER         (not set, deployer stays owner)
  GATEWAY_DEPLOYERS  (none)
  Public gateway     true
  Mode               fresh deployment

Type the chain id (137) to start, anything else aborts:
```

- **Balance too low?** The script stops with `Deployer balance … is below the estimated X needed`. Send about **2 × X** of the
  native token (Polygon: **POL**, withdrawn on the **Polygon PoS** network) to the deployer address and run the command again.
  A deployment uses ~29M gas: at 280 gwei that is about 8 POL.
- Check every line, then type the chain id and press Enter. Anything else aborts without sending.

The run takes 1–3 minutes (about 20 transactions). It ends with:

```
Deployment record and ABIs: …/deployments/137
TREXGateway (entry point for token suite deployments): 0x…
```

In the log, `+` = done now, `=` = already done/nothing to do, `~` = waiting for a transaction from an interrupted run.

## 5. Check the result

- `deployments/<chainId>/deployment.json` has addresses, deploy blocks and transactions, and `"pending": {}`.
- `deployments/<chainId>/abis/` has 15 ABI files.
- The gateway address shows as a contract in the block explorer (Polygon: [polygonscan.com](https://polygonscan.com)).

## 6. Hand over to the platform

Copy the whole `deployments/<chainId>/` folder (16 files) into the platform repository and open a PR:

```bash
CHAIN_ID=137
cd <path-to-platform-repo> && git checkout main && git pull
git checkout -b chore/trex-infra-$CHAIN_ID
mkdir -p <contracts-dir>/$CHAIN_ID
cp -r <path-to-ERC-3643>/deployments/$CHAIN_ID/. <contracts-dir>/$CHAIN_ID/
git add <contracts-dir>/$CHAIN_ID && git status        # expect 16 new files
git commit -m "Add T-REX infrastructure for chain $CHAIN_ID" && git push -u origin HEAD
```

Don't commit `deployments/<chainId>` to the ERC-3643 repo, but keep a backup (e.g. a shared drive). The script needs it for later changes.

## 7. Clean up

```bash
npx hardhat vars delete DEPLOYER_PRIVATE_KEY
```

If the deployer stays admin, keep its key only in the password manager / hardware wallet.

---

## Troubleshooting

Fix the cause, then run the same command again. Only the line starting with `Error` matters.

| Error | Fix |
| --- | --- |
| `HH100: Network target doesn't exist` | `RPC_URL` missing in `.env` |
| `RPC reports chain X, EXPECTED_CHAIN_ID is Y` | `RPC_URL` points to another chain (e.g. a testnet) |
| `DEPLOYER_PRIVATE_KEY is not set` | Step 2 |
| `Deployer balance … is below the estimated …` | Fund the deployer (step 4) |
| `invalid address` / `bad address checksum` / `Invalid …` | Typo in `.env` |
| `could not detect network`, timeout, `429` | RPC overloaded: wait, or switch `RPC_URL` (keep the `deployments/<chainId>` folder) |
| `transaction underpriced` / `gas tip cap` | The RPC suggests too low a fee: switch `RPC_URL` |
| `… was deployed by 0x…, resume it with that key` | Store the original deployer key again (step 2) |
| `… different bytecode than the current artifacts` | Code changed since the first attempt (`git pull`, other branch). Go back to that version, or move `deployments/<chainId>` away to start over |
| `… is stale: no code for …` | Chain was reset (testnets): move `deployments/<chainId>` away, deploy again |
| `… is owned by 0x…, not by the deployer` | Ownership already moved to `TREX_OWNER`: do the change from that wallet |

## Later changes

As long as the deployer is admin, edit `.env` and run `npm run deploy:infra` again (with the original `deployments/<chainId>`
folder and deployer key). Only the difference gets applied:

| Goal | `.env` change |
| --- | --- |
| Close / open the factory | `GATEWAY_PUBLIC_DEPLOYMENT=false` / `true` |
| Allow a wallet to deploy on behalf of issuers | add it to `GATEWAY_DEPLOYERS` |
| Move admin rights to a multisig / hardware wallet | set `TREX_OWNER` (final, can't be undone by the deployer) |

Once `TREX_OWNER` is admin, these changes are made from that wallet (`setPublicDeploymentStatus`, `addDeployer` on `TREXGateway`).

Known T-REX limitation: the factory keeps ownership of each new suite's IdentityRegistryStorage. A token owner who later
wants `changeImplementationAuthority` needs the admin to recover it first (`transferFactoryOwnership` → `recoverContractOwnership`
→ give the factory back to the gateway).
