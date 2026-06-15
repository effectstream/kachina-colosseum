import {
  type BatcherConfig,
  FileStorage,
  type DefaultBatcherInput,
} from "@effectstream/batcher-sdk";
import { readMidnightContract } from "@effectstream/midnight-contracts/read-contract";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import * as path from "node:path";

const batchIntervalMs = 1000;
const port = Number(process.env.BATCHER_PORT ?? "3334");

// Try to load contract data (needed for the standard midnight adapter).
// May fail if the contract hasn't been deployed yet (no address JSON file).
try {
  readMidnightContract(
    "contract-pvp",
    {
      baseDir: path.resolve(import.meta.dirname!, "..", "midnight"),
      networkId: midnightNetworkConfig.id,
    },
  );
} catch (e) {
  console.warn(
    `⚠️  Could not load contract address file: ${(e as Error).message}`,
  );
  console.warn(
    "   The standard midnight adapter will be disabled. " +
      "The midnight_balancing adapter (for delegated tx) will still work.",
  );
  throw e;
}

export const config: BatcherConfig<DefaultBatcherInput> = {
  pollingIntervalMs: batchIntervalMs,
  enableHttpServer: true,
  // Must match the node's setSecurityNamespace(...) and any signed batcher clients.
  namespace: "pvp-arena",
  confirmationLevel: {
    midnight_balancing: "no-wait",
  },
  enableEventSystem: true,
  port,
};

export const storage = new FileStorage("./batcher-data");

// ---------------------------------------------------------------------------
// Environment validation & startup print
// ---------------------------------------------------------------------------

type EnvEntry = {
  name: string;
  value: string;
  isSet: boolean;
  secret: boolean;
  requiredWhenDeployed: boolean;
};

function printEnvTable(title: string, entries: EnvEntry[]): string[] {
  const errors: string[] = [];
  const nameW = Math.max(...entries.map((e) => e.name.length));
  const valW = 38;

  const lineW = nameW + valW + 16;
  const sep = "=".repeat(lineW);

  console.log(`\n${sep}`);
  console.log(`  ${title}`);
  console.log(sep);
  console.log(
    `  ${"Variable".padEnd(nameW)}  ${"Value".padEnd(valW)}  Status`,
  );
  console.log(`  ${"-".repeat(nameW)}  ${"-".repeat(valW)}  ----------`);

  for (const e of entries) {
    let display: string;
    let status: string;

    if (e.secret) {
      display = e.isSet ? "****" : "(not set)";
      status = e.isSet ? "set" : "(not set)";
    } else {
      display = e.value || "(not set)";
      if (display.length > valW) display = display.slice(0, valW - 3) + "...";
      status = e.isSet ? "overridden" : "default";
    }

    console.log(
      `  ${e.name.padEnd(nameW)}  ${display.padEnd(valW)}  ${status}`,
    );

    if (e.requiredWhenDeployed && !e.isSet && !e.value) {
      errors.push(`FATAL: ${e.name} is required for deployed networks but is not set.`);
    }
  }

  console.log(`${sep}\n`);
  return errors;
}

export function validateAndPrintBatcherEnv(): void {
  const networkId = midnightNetworkConfig.id as string;
  const isDeployed = networkId !== "undeployed";

  const entries: EnvEntry[] = [
    {
      name: "MIDNIGHT_NETWORK_ID",
      value: networkId,
      isSet: !!process.env.MIDNIGHT_NETWORK_ID,
      secret: false,
      requiredWhenDeployed: false,
    },
    {
      name: "MIDNIGHT_WALLET_SEED",
      value: process.env.MIDNIGHT_WALLET_SEED ?? "",
      isSet: !!process.env.MIDNIGHT_WALLET_SEED,
      secret: true,
      requiredWhenDeployed: false,
    },
    {
      name: "MIDNIGHT_WALLET_MNEMONIC",
      value: process.env.MIDNIGHT_WALLET_MNEMONIC ?? "",
      isSet: !!process.env.MIDNIGHT_WALLET_MNEMONIC?.trim(),
      secret: true,
      requiredWhenDeployed: false,
    },
    {
      name: "MIDNIGHT_WALLET_SEEDS",
      value: process.env.MIDNIGHT_WALLET_SEEDS ?? "",
      isSet: !!process.env.MIDNIGHT_WALLET_SEEDS,
      secret: true,
      requiredWhenDeployed: true,
    },
    {
      name: "MIDNIGHT_INDEXER_HTTP",
      value: midnightNetworkConfig.indexer,
      isSet: !!process.env.MIDNIGHT_INDEXER_HTTP,
      secret: false,
      requiredWhenDeployed: false,
    },
    {
      name: "MIDNIGHT_INDEXER_WS",
      value: midnightNetworkConfig.indexerWS,
      isSet: !!process.env.MIDNIGHT_INDEXER_WS,
      secret: false,
      requiredWhenDeployed: false,
    },
    {
      name: "MIDNIGHT_NODE_HTTP",
      value: midnightNetworkConfig.node,
      isSet: !!process.env.MIDNIGHT_NODE_HTTP,
      secret: false,
      requiredWhenDeployed: false,
    },
    {
      name: "MIDNIGHT_PROOF_SERVER_URL",
      value: midnightNetworkConfig.proofServer,
      isSet: !!(process.env.MIDNIGHT_PROOF_SERVER_URL || process.env.MIDNIGHT_PROOF_SERVER),
      secret: false,
      requiredWhenDeployed: false,
    },
    {
      name: "BATCHER_PORT",
      value: String(port),
      isSet: !!process.env.BATCHER_PORT,
      secret: false,
      requiredWhenDeployed: false,
    },
    {
      name: "MIDNIGHT_TOKEN_ID",
      value: process.env.MIDNIGHT_TOKEN_ID || "(default)",
      isSet: !!process.env.MIDNIGHT_TOKEN_ID,
      secret: false,
      requiredWhenDeployed: false,
    },
  ];

  const errors = printEnvTable("PVP Arena — Batcher Environment", entries);

  if (isDeployed && !midnightNetworkConfig.walletSeed) {
    errors.push(
      `FATAL: For network '${networkId}', either MIDNIGHT_WALLET_SEED or MIDNIGHT_WALLET_MNEMONIC must be set.`,
    );
  }

  if (isDeployed && errors.length > 0) {
    for (const err of errors) console.error(err);
    process.exit(1);
  }
}
