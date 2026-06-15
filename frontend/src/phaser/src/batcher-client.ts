import { toHex } from "@midnight-ntwrk/compact-runtime";

// Use env var if available (e.g. testnet), fall back to localhost for local dev.
const DEFAULT_BATCHER_URL = import.meta.env.VITE_BATCHER_MODE_BATCHER_URL || "http://localhost:3334";

// Security namespace — must match batcher BatcherConfig.namespace and node
// setSecurityNamespace("epvp-arena"). Used when signing EVM batcher inputs.
export const SECURITY_NAMESPACE = "pvp-arena";

/** Sentinel message thrown by balanceTx when the delegation hook intercepts the transaction. */
export const DELEGATED_SENTINEL = "Delegated balancing flow handed off to batcher";

/**
 * BatcherClient sends proven (unbound) transactions to the batcher, which handles
 * dust balancing and submission server-side.
 *
 * The browser proves the circuit client-side via httpClientProofProvider (local proof server).
 * balanceTx receives the UnboundTransaction (proven, no dust) and delegates to the batcher.
 * The batcher's MidnightBalancingAdapter balances the unbound tx with its dust wallet.
 */
export class BatcherClient {

  static circuitName = "";
  public static setCircuitName(circuitName: string) {
    this.circuitName = circuitName;
  }

  /**
   * Serializes an already-proven UnboundTransaction and delegates dust balancing to the batcher.
   *
   * @param tx The proven UnboundTransaction (must have .serialize()).
   * @returns The batcher's transaction hash, or null on failure.
   */
  public static async delegatedBalanceHook(
    tx: { serialize(): Uint8Array },
  ): Promise<string | null> {
    const serializedTx = toHex(tx.serialize());
    const circuitId = this.circuitName || 'unknown';
    BatcherClient.setCircuitName('');
    return await this.postToBatcher(serializedTx, circuitId, "unbound");
  }

  private static async postToBatcher(
    serializedTx: string,
    circuitId: string,
    txStage: "unproven" | "unbound" | "finalized" = "unbound",
  ): Promise<string | null> {
    console.log(
      `🔍 [BatcherClient] Posting to Batcher at ${DEFAULT_BATCHER_URL}/send-input...`,
    );
    const body = {
      data: {
        target: "midnight_balancing",
        address: "moderator_trusted_node",
        addressType: 0,
        input: JSON.stringify({
          tx: serializedTx,
          txStage: txStage,
          circuitId: circuitId,
        }),
        timestamp: Date.now(),
      },
      confirmationLevel: "wait-receipt",
    };

    try {
      const response = await fetch(`${DEFAULT_BATCHER_URL}/send-input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(
          `❌ [BatcherClient] Batcher rejected transaction (HTTP ${response.status}):`,
          text,
        );
        throw new Error(`Batcher rejected transaction: ${text}`);
      }

      const result = await response.json();
      if (!result.success) {
        console.error(`❌ [BatcherClient] Batcher failed:`, result.message);
        throw new Error(`Batcher failed: ${result.message}`);
      }
      console.log('>>>', result);

      const txHash: string | null = result.transactionHash ?? null;
      console.log(
        `✅ [BatcherClient] ${circuitId} submitted successfully via batcher! txHash=${txHash}`,
      );
      return txHash;
    } catch (e) {
      console.error(`❌ [BatcherClient] Network error calling batcher:`, e);
      throw e;
    }
  }
}
