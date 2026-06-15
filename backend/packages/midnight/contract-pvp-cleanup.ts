#!/usr/bin/env bun
/**
 * Clean up a finished PVP Arena match.
 *
 * Calls the `cleanup_match(matchId)` circuit on the deployed contract,
 * removing all ledger entries for a finished match.
 *
 * Transaction balancing and submission are delegated to the batcher
 * (the cleanup wallet does not need NIGHT tokens for dust).
 *
 * The caller must be the contract owner (using MIDNIGHT_BACKEND_SECRET)
 * or a participant in the match.
 *
 * Usage:
 *   MIDNIGHT_NETWORK_ID=undeployed \
 *   MIDNIGHT_STORAGE_PASSWORD="YourPasswordMy1!" \
 *   MIDNIGHT_BACKEND_SECRET="<hex-or-string>" \
 *   MIDNIGHT_CLEAN_SEED="<seed>" \
 *   BATCHER_URL="http://localhost:3334" \
 *   bun run backend/packages/midnight/contract-pvp-cleanup.ts <match_id>
 *
 * Arguments:
 *   match_id  The match ID (bigint or hex) to clean up
 *
 * Requires: proof server + batcher running.
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
} from "@effectstream/midnight-contracts";
import {
  Contract,
  createPVPArenaPrivateState,
  type PVPArenaPrivateState,
} from "./contract-pvp/src/index.ts";

// ============================================================================
// Constants
// ============================================================================

const BATCHER_URL = process.env.BATCHER_URL || "http://localhost:3334";
const DELEGATED_TX_SENTINEL = "delegated-to-batcher";

// ============================================================================
// Parse arguments
// ============================================================================

const matchIdArg = process.argv[2];
if (!matchIdArg) {
  console.error("Usage: contract-pvp-cleanup.ts <match_id>");
  console.error("  match_id: The match ID (bigint or 0x-prefixed hex) to clean up");
  process.exit(1);
}

/**
 * The ledger parser emits match IDs as 0x-prefixed hex of raw little-endian
 * bytes (via alignedValueToHex). To pass them to a Compact circuit as a Field,
 * we must interpret those bytes as a little-endian bigint — the same conversion
 * that compact-runtime's valueToBigInt performs.
 */
function hexLeToFieldBigInt(hex: string): bigint {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Parse pairs of hex chars as LE bytes
  let result = 0n;
  for (let i = 0; i < raw.length; i += 2) {
    const byte = BigInt(parseInt(raw.slice(i, i + 2), 16));
    result |= byte << BigInt((i / 2) * 8);
  }
  return result;
}

const matchId = matchIdArg.startsWith("0x")
  ? hexLeToFieldBigInt(matchIdArg)
  : BigInt(matchIdArg);
console.log(`Match ID to clean up: ${matchId}`);

// ============================================================================
// Secret key for the owner
// ============================================================================

function getBackendSecret(): Uint8Array {
  const raw = process.env.MIDNIGHT_BACKEND_SECRET!;
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
setNetworkId(networkId);

const contractAddress = loadContractAddress();
console.log(`Network: ${networkId}`);
console.log(`Contract: ${contractAddress}`);

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

// Check batcher
try {
  const resp = await fetch(`${BATCHER_URL}/health`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  console.log(`Batcher: OK (${BATCHER_URL})`);
} catch {
  console.error(`Batcher not running at ${BATCHER_URL}`);
  process.exit(1);
}

// Build wallet (keys only — batcher handles balancing/dust)
console.log("\n--- Building wallet (keys only, batcher handles balancing) ---");
const walletSeed = process.env.MIDNIGHT_CLEAN_SEED!;
const walletResult = await buildWalletFacade(NETWORK as any, walletSeed, networkId);
console.log(`Unshielded address: ${walletResult.unshieldedAddress}`);

// Set up providers
const here = path.dirname(path.fromFileUrl(import.meta.url));
const managedDir = path.resolve(path.join(here, "contract-pvp/src/managed"));
const zkConfigPath = path.resolve(path.join(managedDir, "pvp"));
const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);

// Batcher delegation: balanceTx posts the proven tx to the batcher, submitTx returns a sentinel.
let pendingTxHash: string | null = null;

const walletAndMidnightProvider = {
  getCoinPublicKey(): CoinPublicKey {
    return walletResult.zswapSecretKeys.coinPublicKey;
  },
  getEncryptionPublicKey(): EncPublicKey {
    return walletResult.zswapSecretKeys.encryptionPublicKey;
  },
  async balanceTx(tx: UnboundTransaction): Promise<FinalizedTransaction> {
    const serializedTx = Buffer.from(tx.serialize()).toString("hex");
    const body = {
      data: {
        target: "midnight_balancing",
        address: "moderator_trusted_node",
        addressType: 0,
        input: JSON.stringify({ tx: serializedTx, txStage: "unbound", circuitId: "cleanup_match" }),
        timestamp: Date.now(),
      },
      confirmationLevel: "wait-receipt",
    };
    const response = await fetch(`${BATCHER_URL}/send-input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Batcher rejected transaction (HTTP ${response.status}): ${text}`);
    }
    const result = await response.json();
    if (!result.success) throw new Error(`Batcher failed: ${result.message}`);
    pendingTxHash = result.transactionHash ?? null;
    console.log(`[cleanup] Batcher confirmed txHash=${pendingTxHash}`);
    return tx as unknown as FinalizedTransaction;
  },
  submitTx(_tx: FinalizedTransaction): Promise<TransactionId> {
    return Promise.resolve(DELEGATED_TX_SENTINEL as unknown as TransactionId);
  },
};

// Query indexer for the ZK identifier of a transaction by its hash.
const getTxIdentifierByHash = async (txHash: string): Promise<string | null> => {
  const query = `
    query GetTxByHash($hash: String!) {
      transactions(offset: { hash: $hash }) {
        ... on RegularTransaction { identifiers }
      }
    }
  `;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(NETWORK.indexer, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { hash: txHash } }),
      });
      const json = await response.json();
      const txs: any[] = json?.data?.transactions ?? [];
      if (txs.length > 0 && Array.isArray(txs[0].identifiers) && txs[0].identifiers.length > 0) {
        console.log(`[cleanup] txHash=${txHash} → identifier=${txs[0].identifiers[0]} (attempt ${attempt})`);
        return txs[0].identifiers[0] as string;
      }
    } catch (e) {
      console.warn(`[cleanup:getTxIdentifierByHash] attempt ${attempt} error:`, e);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
};

// Wrap publicDataProvider to intercept the sentinel txId from batcher delegation.
const basePublicDataProvider = indexerPublicDataProvider(NETWORK.indexer, NETWORK.indexerWS);
const publicDataProvider = {
  ...basePublicDataProvider,
  watchForTxData: async (txId: any): Promise<any> => {
    if ((txId as string) !== DELEGATED_TX_SENTINEL) {
      return basePublicDataProvider.watchForTxData(txId);
    }
    const txHash = pendingTxHash;
    pendingTxHash = null;
    if (txHash) {
      console.log(`[cleanup] watchForTxData: resolving identifier for txHash=${txHash}...`);
      const identifier = await getTxIdentifierByHash(txHash);
      if (identifier) {
        console.log(`[cleanup] watchForTxData: waiting for chain confirmation via identifier=${identifier}`);
        return basePublicDataProvider.watchForTxData(identifier as any);
      }
      console.warn("[cleanup] watchForTxData: could not resolve identifier, returning mock");
    }
    return {
      tx: null as any,
      status: "succeed-entirely",
      txId,
      identifiers: [],
      txHash: DELEGATED_TX_SENTINEL as any,
      blockHash: DELEGATED_TX_SENTINEL,
      blockHeight: 0,
      blockTimestamp: Date.now(),
      blockAuthor: null,
      indexerId: 0,
      protocolVersion: 0,
      fees: { paidFees: "0", estimatedFees: "0" },
      segmentStatusMap: undefined,
      unshielded: { created: [], spent: [] },
    };
  },
};

const providers: MidnightProviders = {
  privateStateProvider: levelPrivateStateProvider({
    midnightDbName: "midnight-level-db-pvp-cleanup",
    privateStateStoreName: "pvp-private-state-cleanup",
    signingKeyStoreName: "pvp-signing-keys-cleanup",
    privateStoragePasswordProvider: async () => process.env.MIDNIGHT_STORAGE_PASSWORD ?? "YourPasswordMy1!",
    accountId: Buffer.from(walletResult.zswapSecretKeys.coinPublicKey).toString("hex"),
  }),
  publicDataProvider,
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

console.log(`Contract found. Calling cleanup_match(${matchId})...`);

// Call cleanup_match
try {
  await (foundContract.callTx as any).cleanup_match(matchId);
  console.log(`cleanup_match(${matchId}) succeeded — match ledger entries removed.`);
} catch (err) {
  console.error("cleanup_match() failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}

// Cleanup
await walletResult.wallet.stop();
console.log("Done.");
process.exit(0);
