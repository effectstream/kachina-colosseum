#!/usr/bin/env bun
/**
 * Initialize the PVP Arena contract owner.
 *
 * Calls the `initialize()` circuit on an already-deployed contract,
 * setting the owner to `derive_public_key(player_secret_key())`.
 *
 * The secret key is read from MIDNIGHT_BACKEND_SECRET env var.
 * If unset, defaults to "MIDNIGHT_BACKEND_SECRET" (for local dev).
 *
 * Usage:
 *   MIDNIGHT_NETWORK_ID=undeployed \
 *   MIDNIGHT_STORAGE_PASSWORD="YourPasswordMy1!" \
 *   MIDNIGHT_BACKEND_SECRET="<hex-or-string>" \
 *   bun run backend/packages/midnight/contract-pvp-initialize.ts
 */

import { Buffer } from "node:buffer";
import * as path from "node:path";
import { readFileSync } from "node:fs";

import { setNetworkId } from "npm:@midnight-ntwrk/midnight-js-network-id@4.0.2";
import { findDeployedContract } from "npm:@midnight-ntwrk/midnight-js-contracts@4.0.2";
import { CompiledContract, type Contract as ContractType } from "npm:@midnight-ntwrk/compact-js@2.5.0";
import type { PrivateStateId, MidnightProviders, UnboundTransaction } from "npm:@midnight-ntwrk/midnight-js-types@4.0.2";
import type {
  CoinPublicKey,
  EncPublicKey,
  FinalizedTransaction,
  TransactionId,
} from "npm:@midnight-ntwrk/ledger-v8@8.0.3";
import { httpClientProofProvider } from "npm:@midnight-ntwrk/midnight-js-http-client-proof-provider@4.0.2";
import { indexerPublicDataProvider } from "npm:@midnight-ntwrk/midnight-js-indexer-public-data-provider@4.0.2";
import { levelPrivateStateProvider } from "npm:@midnight-ntwrk/midnight-js-level-private-state-provider@4.0.2";
import { NodeZkConfigProvider } from "npm:@midnight-ntwrk/midnight-js-node-zk-config-provider@4.0.2";

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import {
  buildWalletFacade,
  syncAndWaitForFunds,
  registerNightForDust,
  waitForDustFunds,
} from "@effectstream/midnight-contracts";
import {
  Contract,
  createPVPArenaPrivateState,
  type PVPArenaPrivateState,
} from "./contract-pvp/src/index.ts";

// ============================================================================
// Constants
// ============================================================================

const TTL_DURATION_MS = 60 * 60 * 1000;

function createTtl(): Date {
  return new Date(Date.now() + TTL_DURATION_MS);
}

// ============================================================================
// Secret key for the owner
// ============================================================================

function getBackendSecret(): Uint8Array {
  const raw = process.env.MIDNIGHT_BACKEND_SECRET ?? "MIDNIGHT_BACKEND_SECRET";
  // If it looks like hex (64 chars), decode it; otherwise use UTF-8 bytes padded/truncated to 32
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return new Uint8Array(Buffer.from(raw, "hex"));
  }
  const bytes = new TextEncoder().encode(raw);
  const key = new Uint8Array(32);
  key.set(bytes.slice(0, 32));
  return key;
}

// ============================================================================
// Load deployed contract address
// ============================================================================

function loadContractAddress(): string {
  const here = path.dirname(path.fromFileUrl(import.meta.url));
  const networkId = midnightNetworkConfig.id;
  const filePath = path.join(here, `contract-pvp.${networkId}.json`);
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  if (!data.contractAddress) {
    throw new Error(`No contractAddress found in ${filePath}`);
  }
  return data.contractAddress;
}

// ============================================================================
// Witnesses — override player_secret_key to use MIDNIGHT_BACKEND_SECRET
// ============================================================================

const backendSecret = getBackendSecret();

const witnesses = {
  player_secret_key: ({ privateState }: { privateState: PVPArenaPrivateState }): [PVPArenaPrivateState, Uint8Array] => [
    privateState,
    backendSecret,
  ],
  current_match_id: ({ privateState }: { privateState: PVPArenaPrivateState }): [PVPArenaPrivateState, bigint] => [
    privateState,
    privateState.currentMatchId!,
  ],
  player_commands: ({ privateState }: { privateState: PVPArenaPrivateState }): [PVPArenaPrivateState, bigint[]] => [
    privateState,
    privateState.commands,
  ],
  player_stances: ({ privateState }: { privateState: PVPArenaPrivateState }): [PVPArenaPrivateState, any[]] => [
    privateState,
    privateState.stances,
  ],
};

// ============================================================================
// Main
// ============================================================================

const networkId = midnightNetworkConfig.id as import("npm:@midnight-ntwrk/wallet-sdk-abstractions@2.0.0").NetworkId.NetworkId;
if (midnightNetworkConfig.id === "mainnet") {
  // We require to set a custom RPC
  if (!process.env.MIDNIGHT_NODE_URL) {
    throw new Error("MIDNIGHT_NODE_URL is not set");
  }
  midnightNetworkConfig.node = process.env.MIDNIGHT_NODE_URL!;
 }

setNetworkId(networkId);

const contractAddress = loadContractAddress();
console.log(`Network: ${networkId}`);
console.log(`Contract: ${contractAddress}`);
console.log(`Backend secret: ${backendSecret.length} bytes`);

const NETWORK = {
  indexer: midnightNetworkConfig.indexer,
  indexerWS: midnightNetworkConfig.indexerWS,
  node: midnightNetworkConfig.node,
  proofServer: midnightNetworkConfig.proofServer,
};

// Check proof server
try {
  const resp = await fetch(`${NETWORK.proofServer}/health`);
  const data = await resp.json();
  if (data.status !== "ok") throw new Error("unhealthy");
  console.log("Proof server: OK");
} catch {
  console.error(`Proof server not running at ${NETWORK.proofServer}`);
  process.exit(1);
}

// Build wallet
console.log("\n--- Building wallet ---");
const walletSeed = midnightNetworkConfig.walletSeed;
const walletResult = await buildWalletFacade(NETWORK as any, walletSeed, networkId);
console.log(`Unshielded address: ${walletResult.unshieldedAddress}`);

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

// Set up providers
const here = path.dirname(path.fromFileUrl(import.meta.url));
const managedDir = path.resolve(path.join(here, "contract-pvp/src/managed"));
const zkConfigPath = path.resolve(path.join(managedDir, "pvp"));
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
    midnightDbName: "midnight-level-db-pvp-initialize",
    privateStateStoreName: "pvp-private-state-initialize",
    signingKeyStoreName: "pvp-signing-keys-initialize",
    privateStoragePasswordProvider: async () => process.env.MIDNIGHT_STORAGE_PASSWORD ?? "YourPasswordMy1!",
    accountId: Buffer.from(walletResult.zswapSecretKeys.coinPublicKey).toString("hex"),
  }),
  publicDataProvider: indexerPublicDataProvider(NETWORK.indexer, NETWORK.indexerWS),
  zkConfigProvider,
  proofProvider: httpClientProofProvider(NETWORK.proofServer, zkConfigProvider),
  walletProvider: walletAndMidnightProvider,
  midnightProvider: walletAndMidnightProvider,
};

// Find deployed contract
console.log("\n--- Finding deployed contract ---");

const pvpCompiledContract = CompiledContract.make("contract-pvp", Contract as any).pipe(
  CompiledContract.withWitnesses(witnesses as never),
  CompiledContract.withCompiledFileAssets(managedDir),
);

const initialPrivateState = createPVPArenaPrivateState(backendSecret) as ContractType.PrivateState<any>;

const foundContract = await findDeployedContract(providers, {
  contractAddress,
  compiledContract: pvpCompiledContract as any,
  privateStateId: "pvpPrivateState" as PrivateStateId,
  initialPrivateState,
});

console.log("Contract found. Calling initialize()...");

// Call initialize
try {
  await (foundContract.callTx as any).initialize();
  console.log("initialize() succeeded — owner is now set.");
} catch (err) {
  console.error("initialize() failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}

// Cleanup
await walletResult.wallet.stop();
console.log("Done.");
process.exit(0);
