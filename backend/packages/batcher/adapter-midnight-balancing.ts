import { MidnightBalancingAdapter } from "@effectstream/batcher-sdk";
import { readMidnightContract } from "@effectstream/midnight-contracts/read-contract";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import * as path from "node:path";

let midnightContractData: ReturnType<typeof readMidnightContract> | null = null;
try {
  midnightContractData = readMidnightContract(
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

const _zkConfigPath = midnightContractData?.zkConfigPath ??
  path.resolve(
    import.meta.dirname!,
    "..", "midnight", "contract-pvp", "src", "managed",
  );

let seeds = process.env.MIDNIGHT_WALLET_SEEDS?.split(",");
if (midnightNetworkConfig.id === "undeployed") {
  seeds = [midnightNetworkConfig.walletSeed!];
} else {
  if (!seeds || seeds.length === 0) {
    throw new Error("MIDNIGHT_WALLET_SEEDS is not set");
  }
}

export const midnightBalancingAdapter = new MidnightBalancingAdapter(
  seeds,
  {
    syncProtocolName: "parallelMidnight",
    indexer: midnightNetworkConfig.indexer,
    indexerWS: midnightNetworkConfig.indexerWS,
    node: midnightNetworkConfig.node,
    proofServer: midnightNetworkConfig.proofServer,
    walletNetworkId: midnightNetworkConfig.id,
    walletFundingTimeoutSeconds: 60 * 20,
    addShieldedPadding: false,
  },
);
