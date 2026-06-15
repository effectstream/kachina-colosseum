#!/usr/bin/env -S deno run -A --unstable-detect-cjs
/**
 * Token Mint: Deploy + Mint 100M shielded tokens to the caller (wallet-1).
 *
 * Usage:
 *   MIDNIGHT_NETWORK_ID=preview \
 *   MIDNIGHT_STORAGE_PASSWORD="YourPasswordMy1!" \
 *   MIDNIGHT_WALLET_MNEMONIC="word1 word2 ..." \
 *   deno run -A --unstable-detect-cjs token-mint-deploy.ts
 *
 * The proof server must be running locally at http://127.0.0.1:6300.
 */

import { Buffer } from "node:buffer";
import * as path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { setNetworkId } from "npm:@midnight-ntwrk/midnight-js-network-id@4.0.0-rc.2";
import { deployContract, findDeployedContract } from "npm:@midnight-ntwrk/midnight-js-contracts@4.0.0-rc.2";
import { CompiledContract, type Contract as ContractType } from "npm:@midnight-ntwrk/compact-js@2.5.0-rc.3";
import type { PrivateStateId, MidnightProviders, UnboundTransaction } from "npm:@midnight-ntwrk/midnight-js-types@4.0.0-rc.2";
import type {
  CoinPublicKey,
  EncPublicKey,
  FinalizedTransaction,
  TransactionId,
} from "npm:@midnight-ntwrk/ledger-v8@8.0.2";
import { httpClientProofProvider } from "npm:@midnight-ntwrk/midnight-js-http-client-proof-provider@4.0.0-rc.2";
import { indexerPublicDataProvider } from "npm:@midnight-ntwrk/midnight-js-indexer-public-data-provider@4.0.0-rc.2";
import { levelPrivateStateProvider } from "npm:@midnight-ntwrk/midnight-js-level-private-state-provider@4.0.0-rc.2";
import { NodeZkConfigProvider } from "npm:@midnight-ntwrk/midnight-js-node-zk-config-provider@4.0.0-rc.2";

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import {
  buildWalletFacade,
  syncAndWaitForFunds,
  registerNightForDust,
  waitForDustFunds,
  type WalletResult,
} from "@effectstream/midnight-contracts";

import {
  Contract,
  createTokenMintPrivateState,
  witnesses,
} from "./contract-token-mint/src/index.ts";

// ============================================================================
// Constants
// ============================================================================

const MINT_AMOUNT = 100_000_000n; // 100M tokens
const TTL_DURATION_MS = 60 * 60 * 1000;
const CONTRACT_NAME = "contract-token-mint";

// ============================================================================
// Helpers
// ============================================================================

function createTtl(): Date {
  return new Date(Date.now() + TTL_DURATION_MS);
}

function loadWalletSeed(): string {
  const mnemonic = process.env.MIDNIGHT_WALLET_MNEMONIC;
  const seed = process.env.MIDNIGHT_WALLET_SEED;
  if (seed) return seed;
  if (!mnemonic) {
    throw new Error("Set MIDNIGHT_WALLET_MNEMONIC or MIDNIGHT_WALLET_SEED");
  }
  // midnightNetworkConfig already resolved the seed from mnemonic
  return midnightNetworkConfig.walletSeed;
}

// ============================================================================
// Main
// ============================================================================

const networkId = midnightNetworkConfig.id as import("npm:@midnight-ntwrk/wallet-sdk-abstractions@2.0.0").NetworkId.NetworkId;
setNetworkId(networkId);

console.log(`Network: ${networkId}`);
console.log(`Indexer: ${midnightNetworkConfig.indexer}`);
console.log(`Node: ${midnightNetworkConfig.node}`);
console.log(`Proof server: ${midnightNetworkConfig.proofServer}`);

// Check proof server health
try {
  const resp = await fetch(`${midnightNetworkConfig.proofServer}/health`);
  const data = await resp.json();
  if (data.status !== "ok") throw new Error("unhealthy");
  console.log("Proof server: OK");
} catch {
  console.error(`Proof server not running at ${midnightNetworkConfig.proofServer}`);
  process.exit(1);
}

const NETWORK = {
  indexer: midnightNetworkConfig.indexer,
  indexerWS: midnightNetworkConfig.indexerWS,
  node: midnightNetworkConfig.node,
  proofServer: midnightNetworkConfig.proofServer,
};

const walletSeed = loadWalletSeed();

// ============================================================================
// Step 1: Build wallet
// ============================================================================

console.log("\n--- Building wallet ---");
const walletResult = await buildWalletFacade(NETWORK as any, walletSeed, networkId);
console.log(`Unshielded address: ${walletResult.unshieldedAddress}`);
console.log(`Dust address: ${walletResult.dustAddress}`);

console.log("Syncing wallet...");
const balances = await syncAndWaitForFunds(walletResult.wallet, {
  waitNonZero: false,
  timeoutMs: 300_000,
} as any);
console.log(`Shielded: ${balances.shieldedBalance}, Unshielded: ${balances.unshieldedBalance}, Dust: ${balances.dustBalance}`);

if (balances.dustBalance === 0n && balances.unshieldedBalance > 0n) {
  console.log("Registering NIGHT for dust...");
  await registerNightForDust(walletResult);
  const dust = await waitForDustFunds(walletResult.wallet, { waitNonZero: true, timeoutMs: 300_000 });
  console.log(`Dust balance after registration: ${dust}`);
}

// ============================================================================
// Step 2: Set up providers
// ============================================================================

const here = path.dirname(path.fromFileUrl(import.meta.url));
const managedDir = path.resolve(path.join(here, "contract-token-mint/src/managed"));
const zkConfigPath = path.resolve(path.join(managedDir, "token_mint"));

const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);

const walletAndMidnightProvider = {
  getCoinPublicKey(): CoinPublicKey {
    return walletResult.zswapSecretKeys.coinPublicKey;
  },
  getEncryptionPublicKey(): EncPublicKey {
    return walletResult.zswapSecretKeys.encryptionPublicKey;
  },
  async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
    const bound = tx.bind();
    const recipe = await walletResult.wallet.balanceFinalizedTransaction(bound, {
      shieldedSecretKeys: walletResult.zswapSecretKeys,
      dustSecretKey: walletResult.dustSecretKey,
    }, { ttl: ttl ?? createTtl() });
    const signed = await walletResult.wallet.signRecipe(recipe, (payload: Uint8Array) =>
      walletResult.unshieldedKeystore.signData(payload),
    );
    return walletResult.wallet.finalizeRecipe(signed);
  },
  submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
    return walletResult.wallet.submitTransaction(tx);
  },
};

const providers: MidnightProviders = {
  privateStateProvider: levelPrivateStateProvider({
    midnightDbName: "midnight-level-db-token-mint",
    privateStateStoreName: "token-mint-private-state",
    signingKeyStoreName: "token-mint-signing-keys",
    privateStoragePasswordProvider: async () => process.env.MIDNIGHT_STORAGE_PASSWORD ?? "YourPasswordMy1!",
    accountId: Buffer.from(walletResult.zswapSecretKeys.coinPublicKey).toString("hex"),
  }),
  publicDataProvider: indexerPublicDataProvider(NETWORK.indexer, NETWORK.indexerWS),
  zkConfigProvider,
  proofProvider: httpClientProofProvider(NETWORK.proofServer, zkConfigProvider),
  walletProvider: walletAndMidnightProvider,
  midnightProvider: walletAndMidnightProvider,
};

// ============================================================================
// Step 3: Deploy the contract
// ============================================================================

const compiledContract = CompiledContract.make(CONTRACT_NAME, Contract as any).pipe(
  CompiledContract.withWitnesses(witnesses as never),
  CompiledContract.withCompiledFileAssets(managedDir),
);

const initialPrivateState = createTokenMintPrivateState() as ContractType.PrivateState<any>;
const outputPath = path.join(here, `contract-token-mint.${networkId}.json`);

// Check if already deployed
let contractAddress: string;
try {
  const existing = JSON.parse(await readFile(outputPath, "utf8"));
  if (existing.contractAddress) {
    contractAddress = existing.contractAddress;
    console.log(`\n--- Contract already deployed at: ${contractAddress} (skipping deploy) ---`);
  } else {
    throw new Error("no address");
  }
} catch {
  console.log("\n--- Deploying token-mint contract ---");

  const deployedContract = await deployContract(providers, {
    compiledContract: compiledContract as any,
    privateStateId: "tokenMintPrivateState" as PrivateStateId,
    initialPrivateState,
    args: [] as ContractType.InitializeParameters<any>,
    signingKey: undefined,
  });

  contractAddress = deployedContract.deployTxData.public.contractAddress;
  console.log(`Contract deployed at: ${contractAddress}`);

  await writeFile(outputPath, JSON.stringify({ contractAddress }, null, 2));
  console.log(`Address saved to: ${outputPath}`);
}

// ============================================================================
// Step 4: Reconnect to deployed contract (fetch on-chain state with owner set)
// ============================================================================

console.log("\n--- Reconnecting to deployed contract ---");

const foundContract = await findDeployedContract(providers, {
  contractAddress,
  compiledContract: compiledContract as any,
  privateStateId: "tokenMintPrivateState" as PrivateStateId,
  initialPrivateState,
});

console.log("Contract found with on-chain state.");

// ============================================================================
// Step 5: Mint 100M tokens
// ============================================================================

console.log(`\n--- Minting ${MINT_AMOUNT} shielded tokens ---`);

const domainSep = new Uint8Array(32);
domainSep[0] = 0x01; // simple domain separator

const nonce = crypto.getRandomValues(new Uint8Array(32));

const txData = await (foundContract.callTx as any).mint_tokens(
  domainSep,
  MINT_AMOUNT,
  nonce,
);

console.log(`Mint transaction successful!`);
console.log(`  Contract: ${contractAddress}`);
console.log(`  Amount: ${MINT_AMOUNT} shielded tokens`);
console.log(`  Recipient: wallet-1 (deployer)`);

// Cleanup
await walletResult.wallet.stop();
console.log("\nDone. 100M shielded tokens minted to wallet-1.");
process.exit(0);
