#!/usr/bin/env -S deno run -A
/**
 * Midnight Wallet CLI
 *
 * Manages multiple Midnight preprod wallets for faucet token farming.
 *
 * Commands:
 *   create   [--name <label>]                          Create a new wallet (BIP39 mnemonic)
 *   import   --mnemonic "words..." [--name <label>]    Import wallet from mnemonic
 *   import   --file <path> [--name <label>]            Import wallet from file containing mnemonic
 *   list                                               List all wallets with addresses
 *   balance  [--name <label>]                          Show NIGHT balances (all if no name)
 *   transfer --from <name> --to <address> --amount <n> Transfer NIGHT tokens
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import * as bip39 from "npm:@scure/bip39@1";
import { wordlist as english } from "npm:@scure/bip39@1/wordlists/english";
import { Buffer } from "node:buffer";
import { setNetworkId } from "npm:@midnight-ntwrk/midnight-js-network-id@4.0.0-rc.2";
import { nativeToken, UnprovenTransaction } from "npm:@midnight-ntwrk/ledger-v8@8.0.2";
import { MidnightBech32m, UnshieldedAddress } from "npm:@midnight-ntwrk/wallet-sdk-address-format@3.1.0-rc.0";

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import {
  buildWalletFacade,
  getInitialShieldedState,
  syncAndWaitForFunds,
  type WalletResult,
  resolveWalletSyncTimeoutMs,
} from "@effectstream/midnight-contracts";

import type { WalletFacade } from "npm:@midnight-ntwrk/wallet-sdk-facade@3.0.1";
import * as Rx from "npm:rxjs";

export async function waitForUnshieldedFunds(
  wallet: WalletFacade,
  options?: { timeoutMs?: number },
): Promise<bigint> {
  console.info("Waiting for unshielded wallet funds...");
  const syncTimeoutMs = options?.timeoutMs ?? resolveWalletSyncTimeoutMs();

  const balance = await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(WALLET_SYNC_THROTTLE_MS),
      Rx.filter((state: any) => {
        const isSynced = state.isSynced ?? false;
        return state.unshielded?.syncProgress?.synced ?? isSynced;
      }),
      Rx.map((state: any) => sumUnshieldedBalances(state.unshielded?.balances)),
      Rx.filter((value: bigint) => value > 0n),
      Rx.timeout({
        each: syncTimeoutMs,
        with: () =>
          Rx.throwError(
            () =>
              new Error(
                `Unshielded wallet sync timeout after ${syncTimeoutMs}ms`,
              ),
          ),
      }),
    ),
  );

  return balance;
}

// ============================================================================
// Constants
// ============================================================================

const WALLETS_FILE = new URL("./wallets.json", import.meta.url).pathname;
const TTL_DURATION_MS = 60 * 60 * 1000;

const NETWORK = {
  indexer: midnightNetworkConfig.indexer,
  indexerWS: midnightNetworkConfig.indexerWS,
  node: midnightNetworkConfig.node,
  proofServer: midnightNetworkConfig.proofServer,
};

const NETWORK_ID = midnightNetworkConfig.id;

// ============================================================================
// Wallet Storage
// ============================================================================

interface StoredWallet {
  name: string;
  mnemonic: string;
  seed: string;
  createdAt: string;
}

function loadWallets(): StoredWallet[] {
  try {
    const data = readFileSync(WALLETS_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveWallets(wallets: StoredWallet[]): void {
  writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2) + "\n");
}

async function mnemonicToSeed(mnemonic: string): Promise<string> {
  const words = mnemonic.trim().split(/\s+/);
  if (!bip39.validateMnemonic(words.join(" "), english)) {
    throw new Error("Invalid mnemonic phrase");
  }
  const seed = await bip39.mnemonicToSeed(words.join(" "));
  return Buffer.from(seed).toString("hex");
}

// ============================================================================
// Wallet Operations
// ============================================================================

function initNetwork(): void {
  setNetworkId(NETWORK_ID);
}

async function requireProofServer(): Promise<void> {
  try {
    const resp = await fetch(`${NETWORK.proofServer}/health`);
    const data = await resp.json();
    if (data.status !== "ok") throw new Error("unhealthy");
  } catch {
    console.error(`Proof server not running at ${NETWORK.proofServer}`);
    console.error(`Start it with: LEDGER_NETWORK_ID=preprod packages/binaries/midnight-proof-server/proof-server/midnight-proof-server`);
    process.exit(1);
  }
}

async function getWalletAddresses(seed: string): Promise<{ unshielded: string; dust: string; shielded: string }> {
  initNetwork();
  const result = await buildWalletFacade(NETWORK, seed, NETWORK_ID);
  const shieldedState = await getInitialShieldedState(result.wallet.shielded);
  const addresses = {
    unshielded: result.unshieldedAddress,
    dust: result.dustAddress,
    shielded: shieldedState.address.coinPublicKeyString(),
  };
  await result.wallet.stop();
  return addresses;
}

function resolveNativeTokenId(): string {
  const token = nativeToken() as unknown as { raw?: string };
  if (typeof token === "string") return token;
  if (token?.raw) return token.raw;
  return String(token);
}

function sumUnshieldedBalances(
  balances: Map<string, bigint> | Record<string, bigint> | undefined,
): bigint {
  if (!balances) return 0n;
  if (balances instanceof Map) {
    return Array.from(balances.values()).reduce((acc, v) => acc + (v ?? 0n), 0n);
  }
  return Object.values(balances).reduce((acc, v) => acc + (v ?? 0n), 0n);
}

// ============================================================================
// Commands
// ============================================================================

async function cmdCreate(name?: string): Promise<void> {
  const wallets = loadWallets();
  const label = name || `wallet-${wallets.length + 1}`;

  if (wallets.find((w) => w.name === label)) {
    console.error(`Wallet "${label}" already exists.`);
    process.exit(1);
  }

  const mnemonic = bip39.generateMnemonic(english, 256); // 24 words
  const seed = await mnemonicToSeed(mnemonic);

  wallets.push({ name: label, mnemonic, seed, createdAt: new Date().toISOString() });
  saveWallets(wallets);

  console.log(`Created wallet "${label}"`);
  console.log(`Mnemonic: ${mnemonic}`);

  // Derive and show address
  initNetwork();
  const result = await buildWalletFacade(NETWORK, seed, NETWORK_ID);
  console.log(`Unshielded address: ${result.unshieldedAddress}`);
  await result.wallet.stop();
}

async function cmdImport(args: { mnemonic?: string; file?: string; name?: string }): Promise<void> {
  let mnemonic: string;

  if (args.file) {
    mnemonic = readFileSync(args.file, "utf8").trim();
  } else if (args.mnemonic) {
    mnemonic = args.mnemonic.trim();
  } else {
    console.error("Provide --mnemonic or --file");
    process.exit(1);
  }

  const seed = await mnemonicToSeed(mnemonic);
  const wallets = loadWallets();
  const label = args.name || `wallet-${wallets.length + 1}`;

  if (wallets.find((w) => w.name === label)) {
    console.error(`Wallet "${label}" already exists.`);
    process.exit(1);
  }

  // Check if same seed already imported
  if (wallets.find((w) => w.seed === seed)) {
    console.error("This mnemonic is already imported.");
    process.exit(1);
  }

  wallets.push({ name: label, mnemonic, seed, createdAt: new Date().toISOString() });
  saveWallets(wallets);

  console.log(`Imported wallet "${label}"`);

  initNetwork();
  const result = await buildWalletFacade(NETWORK, seed, NETWORK_ID);
  console.log(`Unshielded address: ${result.unshieldedAddress}`);
  await result.wallet.stop();
}

async function cmdList(): Promise<void> {
  const wallets = loadWallets();
  if (wallets.length === 0) {
    console.log("No wallets stored. Use 'create' or 'import' first.");
    return;
  }

  initNetwork();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Midnight Preprod Wallets (${wallets.length})`);
  console.log(`${"=".repeat(60)}\n`);

  for (const w of wallets) {
    const result = await buildWalletFacade(NETWORK, w.seed, NETWORK_ID);
    console.log(`  Name:       ${w.name}`);
    console.log(`  Address:    ${result.unshieldedAddress}`);
    console.log(`  Created:    ${w.createdAt}`);
    console.log();
    await result.wallet.stop();
  }
}

interface WalletBalanceResult {
  name: string;
  address: string;
  shieldedBalance: bigint;
  unshieldedBalance: bigint;
  dustBalance: bigint;
  shieldedUtxos: number;
  unshieldedUtxos: number;
  dustUtxos: number;
  error?: string;
}

async function fetchSingleBalance(w: StoredWallet): Promise<WalletBalanceResult> {
  const result: WalletBalanceResult = {
    name: w.name,
    address: "",
    shieldedBalance: 0n,
    unshieldedBalance: 0n,
    dustBalance: 0n,
    shieldedUtxos: 0,
    unshieldedUtxos: 0,
    dustUtxos: 0,
  };

  let walletFacade: WalletResult | null = null;
  try {
    // const Rx = await import("rxjs");
    walletFacade = await buildWalletFacade(NETWORK, w.seed, NETWORK_ID);
    result.address = walletFacade.unshieldedAddress;
    console.log(`[${w.name}] syncing...`);

    const { shieldedBalance, unshieldedBalance } =
      await syncAndWaitForFunds(walletFacade.wallet, {
        waitNonZero: false,
        logLabel: w.name,
        timeoutMs: 300_000,
      });
    result.shieldedBalance = shieldedBalance;
    result.unshieldedBalance = unshieldedBalance;

    // Dust balance & UTXOs
    try {
      // deno-lint-ignore no-explicit-any
      const dustState: any = await Rx.firstValueFrom((walletFacade.wallet as any).dust.state);
      if (typeof dustState.balance === "function") {
        result.dustBalance = dustState.balance(new Date());
      } else if (typeof dustState.walletBalance === "function") {
        result.dustBalance = dustState.walletBalance(new Date());
      }
      if (dustState.availableCoins) result.dustUtxos = dustState.availableCoins.length;
    } catch (_e) { /* ignore */ }

    // Shielded UTXOs
    try {
      // deno-lint-ignore no-explicit-any
      const shieldedState: any = await Rx.firstValueFrom((walletFacade.wallet as any).shielded.state);
      if (shieldedState.availableCoins) result.shieldedUtxos = shieldedState.availableCoins.length;
    } catch (_e) { /* ignore */ }

    // Unshielded UTXOs
    try {
      // deno-lint-ignore no-explicit-any
      const unshieldedState: any = await Rx.firstValueFrom((walletFacade.wallet as any).unshielded.state);
      if (unshieldedState.availableCoins) result.unshieldedUtxos = unshieldedState.availableCoins.length;
    } catch (_e) { /* ignore */ }

    console.log(`[${w.name}] done`);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error(`[${w.name}] error: ${result.error}`);
  } finally {
    if (walletFacade) await walletFacade.wallet.stop().catch(() => {});
  }
  return result;
}

async function cmdBalance(name?: string): Promise<void> {
  const wallets = loadWallets();
  if (wallets.length === 0) {
    console.log("No wallets stored.");
    return;
  }

  const targets = name ? wallets.filter((w) => w.name === name) : wallets;
  if (targets.length === 0) {
    console.error(`Wallet "${name}" not found.`);
    process.exit(1);
  }

  initNetwork();

  const CONCURRENCY = 3;
  console.log(`\nSyncing ${targets.length} wallet(s) in parallel (${CONCURRENCY} at a time)...\n`);
  const results: WalletBalanceResult[] = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map((w) => fetchSingleBalance(w)));
    results.push(...batchResults);
  }

  // Print summary table
  console.log(`\n${"=".repeat(90)}`);
  console.log(`  Midnight Preprod Balances`);
  console.log(`${"=".repeat(90)}`);
  for (const r of results) {
    if (r.error) {
      console.log(`\n  ${r.name}: ERROR — ${r.error}`);
      continue;
    }
    console.log(`\n  ${r.name}`);
    console.log(`    Address:    ${r.address}`);
    console.log(`    Shielded:   ${r.shieldedBalance} NIGHT  (${r.shieldedUtxos} UTXOs)`);
    console.log(`    Unshielded: ${r.unshieldedBalance} NIGHT  (${r.unshieldedUtxos} UTXOs)`);
    console.log(`    Dust:       ${r.dustBalance}  (${r.dustUtxos} UTXOs)`);
  }
  console.log(`\n${"=".repeat(90)}\n`);
}

async function cmdTransfer(args: { from: string; to: string; amount: string }): Promise<void> {
  if (!args.from || !args.to || !args.amount) {
    console.error("Usage: transfer --from <name> --to <address> --amount <NIGHT>");
    process.exit(1);
  }

  await requireProofServer();

  const amount = BigInt(args.amount);
  const wallets = loadWallets();
  const sender = wallets.find((w) => w.name === args.from);
  if (!sender) {
    console.error(`Wallet "${args.from}" not found.`);
    process.exit(1);
  }

  initNetwork();
  console.log(`Building wallet "${sender.name}"...`);
  const senderResult = await buildWalletFacade(NETWORK, sender.seed, NETWORK_ID);
  console.log(`Sender address: ${senderResult.unshieldedAddress}`);
  console.log("Syncing wallet...");

  const { unshieldedBalance } = await syncAndWaitForFunds(senderResult.wallet, {
    waitNonZero: false,
    logLabel: sender.name,
  });

  if (unshieldedBalance === 0n) {
    console.log("Unshielded balance is 0, waiting for funds...");
    await waitForUnshieldedFunds(senderResult.wallet, { timeoutMs: 300_000 });
  }

  console.log(`Transferring ${amount} NIGHT to ${args.to}...`);

  const ttl = new Date(Date.now() + TTL_DURATION_MS);
  const tokenId = resolveNativeTokenId();

  // Resolve token ID from wallet state
  const { default: Rx } = await import("rxjs");
  const state = await Rx.firstValueFrom(senderResult.wallet.state());
  const balances = (state as any).unshielded?.balances as
    | Map<string, bigint>
    | Record<string, bigint>
    | undefined;
  let resolvedTokenId = tokenId;
  if (balances) {
    const keys = balances instanceof Map ? Array.from(balances.keys()) : Object.keys(balances);
    if (keys.includes(tokenId)) resolvedTokenId = tokenId;
    else if (keys.length > 0) resolvedTokenId = keys[0];
  }

  const parsedAddress = MidnightBech32m.parse(args.to).decode(
    UnshieldedAddress,
    senderResult.networkId,
  );

  const recipe = await senderResult.wallet.transferTransaction(
    [{
      type: "unshielded",
      outputs: [{ amount, type: resolvedTokenId, receiverAddress: parsedAddress }],
    }],
    {
      shieldedSecretKeys: senderResult.walletZswapSecretKeys,
      dustSecretKey: senderResult.walletDustSecretKey,
    },
    { ttl },
  );

  const signed: UnprovenTransaction = await senderResult.wallet.signUnprovenTransaction(
    recipe.transaction,
    (payload: Uint8Array) => senderResult.unshieldedKeystore.signData(payload),
  );

  const finalized = await senderResult.wallet.finalizeTransaction(signed);
  const txId = await senderResult.wallet.submitTransaction(finalized);
  console.log(`Transfer submitted! txId: ${txId}`);

  await senderResult.wallet.stop();
}

async function cmdDelegate(args: { name: string; to?: string }): Promise<void> {
  if (!args.name) {
    console.error("Usage: delegate --name <wallet> [--to <dust-address>]");
    process.exit(1);
  }

  await requireProofServer();

  const wallets = loadWallets();
  const wallet = wallets.find((w) => w.name === args.name);
  if (!wallet) {
    console.error(`Wallet "${args.name}" not found.`);
    process.exit(1);
  }

  // If --to is a wallet name (not a dust address), resolve it
  let targetDustAddress: string | undefined;
  if (args.to) {
    const targetWallet = wallets.find((w) => w.name === args.to);
    if (targetWallet) {
      // Build target wallet to get its dust address
      console.log(`Resolving dust address for "${args.to}"...`);
      const targetResult = await buildWalletFacade(NETWORK, targetWallet.seed, NETWORK_ID);
      targetDustAddress = targetResult.dustAddress;
      console.log(`Target dust address: ${targetDustAddress}`);
      await targetResult.wallet.stop();
    } else {
      // Assume it's a raw dust address
      targetDustAddress = args.to;
    }
  }

  initNetwork();
  const Rx = await import("rxjs");

  console.log(`Building wallet "${wallet.name}"...`);
  const walletResult = await buildWalletFacade(NETWORK, wallet.seed, NETWORK_ID);
  console.log(`Unshielded address: ${walletResult.unshieldedAddress}`);
  console.log(`Dust address: ${walletResult.dustAddress}`);
  console.log("Syncing wallet...");

  await syncAndWaitForFunds(walletResult.wallet, {
    waitNonZero: false,
    logLabel: wallet.name,
  });

  // Get synced state and find unregistered UTXOs
  // deno-lint-ignore no-explicit-any
  const state: any = await Rx.firstValueFrom(
    walletResult.wallet.state().pipe(
      // deno-lint-ignore no-explicit-any
      Rx.filter((s: any) => s.isSynced),
    ),
  );

  const allCoins = state.unshielded?.availableCoins ?? [];
  const unregistered = allCoins.filter(
    // deno-lint-ignore no-explicit-any
    (coin: any) => coin.meta.registeredForDustGeneration === false,
  );

  console.log(`\nTotal unshielded UTXOs: ${allCoins.length}`);
  console.log(`Already registered for dust: ${allCoins.length - unregistered.length}`);
  console.log(`Unregistered (to delegate): ${unregistered.length}`);

  if (unregistered.length === 0) {
    console.log("\nAll Night UTXOs are already registered for dust generation.");

    // Show current dust balance
    // deno-lint-ignore no-explicit-any
    const dustState: any = await Rx.firstValueFrom((walletResult.wallet as any).dust.state);
    const dustBalance = typeof dustState.balance === "function" ? dustState.balance(new Date()) : 0n;
    console.log(`Current dust balance: ${dustBalance}`);

    await walletResult.wallet.stop();
    return;
  }

  console.log(`\nRegistering ${unregistered.length} Night UTXO(s) for dust generation...`);
  if (targetDustAddress) {
    console.log(`Delegating dust to: ${targetDustAddress}`);
  } else {
    console.log(`Delegating dust to self (${walletResult.dustAddress})`);
  }

  try {
    // Build registration args
    // deno-lint-ignore no-explicit-any
    const registerArgs: any[] = [
      unregistered,
      walletResult.unshieldedKeystore.getPublicKey(),
      (payload: Uint8Array) => walletResult.unshieldedKeystore.signData(payload),
    ];
    if (targetDustAddress) {
      registerArgs.push(targetDustAddress);
    }

    // deno-lint-ignore no-explicit-any
    const recipe = await (walletResult.wallet as any).registerNightUtxosForDustGeneration(
      ...registerArgs,
    );

    // Use finalizeRecipe which handles dust registration specially (no dust fee needed)
    // deno-lint-ignore no-explicit-any
    const finalizedTx = await (walletResult.wallet as any).finalizeRecipe(recipe);
    const txId = await walletResult.wallet.submitTransaction(finalizedTx);
    console.log(`\nDelegation transaction submitted! txId: ${txId}`);

    // Wait for dust to appear
    console.log("Waiting for dust to generate...");
    // deno-lint-ignore no-explicit-any
    const newDustState: any = await Rx.firstValueFrom(
      (walletResult.wallet as any).dust.state.pipe(
        Rx.throttleTime(10_000),
        // deno-lint-ignore no-explicit-any
        Rx.tap((s: any) => {
          const bal = typeof s.balance === "function" ? s.balance(new Date()) : 0n;
          console.log(`  dust balance: ${bal}`);
        }),
        // deno-lint-ignore no-explicit-any
        Rx.filter((s: any) => {
          return s.availableCoins?.length > 0;
        }),
        Rx.timeout({
          each: 120_000,
          with: () => Rx.throwError(() => new Error("Timeout waiting for dust (120s)")),
        }),
      ),
    );
    const finalDust = typeof newDustState.balance === "function" ? newDustState.balance(new Date()) : 0n;
    console.log(`\nDelegation complete! Dust balance: ${finalDust}`);
  } catch (e) {
    console.error(`Delegation error: ${e instanceof Error ? e.message : String(e)}`);
  }

  await walletResult.wallet.stop();
}

// ============================================================================
// Main
// ============================================================================

if (!process.env.MIDNIGHT_NETWORK_ID) {
  console.error("MIDNIGHT_NETWORK_ID is required. Example:");
  console.error("  MIDNIGHT_NETWORK_ID=preprod deno run -A wallet-cli.ts <command>");
  process.exit(1);
}

const args = parseArgs({
  args: process.argv.slice(2),
  string: ["name", "mnemonic", "file", "from", "to", "amount"],
});

const command = args._[0] as string;

switch (command) {
  case "create":
    await cmdCreate(args.name);
    break;
  case "import":
    await cmdImport({ mnemonic: args.mnemonic, file: args.file, name: args.name });
    break;
  case "list":
    await cmdList();
    break;
  case "balance":
    await cmdBalance(args.name);
    break;
  case "transfer":
    await cmdTransfer({ from: args.from!, to: args.to!, amount: args.amount! });
    break;
  case "delegate":
    await cmdDelegate({ name: args.name!, to: args.to });
    break;
  default:
    console.log(`Midnight Wallet CLI

Commands:
  create    [--name <label>]                          Create a new wallet
  import    --mnemonic "words..." [--name <label>]    Import from mnemonic
  import    --file <path> [--name <label>]            Import from file
  list                                                List wallets with addresses
  balance   [--name <label>]                          Show NIGHT balances
  transfer  --from <name> --to <address> --amount <n> Transfer NIGHT tokens
  delegate  --name <wallet> [--to <wallet|address>]   Register Night for dust generation
`);
    break;
}
