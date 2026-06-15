import {
  init,
  start,
  type StartConfigApiRouter,
  type StartConfigGameStateTransitions,
} from "@effectstream/runtime";
import { main, suspend } from "effection";
import {
  toSyncProtocolWithNetwork,
  withEffectstreamStaticConfig,
} from "@effectstream/config";
import {
  ConfigBuilder,
  ConfigNetworkType,
  ConfigSyncProtocolType,
} from "@effectstream/config";
import type { GrammarDefinition } from "@effectstream/concise";
import { type SyncStateUpdateStream, World } from "@effectstream/coroutine";
import { Stm } from "@effectstream/sm";
import type { BaseStfInput } from "@effectstream/sm";
import { newScheduledTimestampData } from "@effectstream/db";
import { AddressType } from "@effectstream/utils";
import { Type } from "@sinclair/typebox";
import {
  midnightNetworkConfig,
} from "@effectstream/midnight-contracts/midnight-env";
import { PrimitiveTypeMidnightGeneric } from "@effectstream/sm/builtin";
import { readMidnightContract } from "@effectstream/midnight-contracts/read-contract";
import * as path from "node:path";
import { builtinGrammars } from "@effectstream/sm/grammar";
import { spawn } from "node:child_process";
import { valueToBigInt } from "@midnight-ntwrk/compact-runtime";
import {
  ensureTables,
  processLedgerSnapshot,
  processDelegations,
  getLeaderboard,
  getUserLeaderboardStats,
  resolveUserIdentity,
  getUserAchievements,
} from "./leaderboard-db.ts";
import type { AlignedValue, StateValue } from "@midnight-ntwrk/ledger-v8";

// ---------------------------------------------------------------------------
// Re-exports for env-specific entry points
// ---------------------------------------------------------------------------
export {
  ConfigBuilder,
  ConfigNetworkType,
  ConfigSyncProtocolType,
  midnightNetworkConfig,
  PrimitiveTypeMidnightGeneric,
};

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
  const dash = "-".repeat(lineW);

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

export function validateAndPrintNodeEnv(): void {
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
      name: "MIDNIGHT_BACKEND_SECRET",
      value: process.env.MIDNIGHT_BACKEND_SECRET ?? "",
      isSet: !!process.env.MIDNIGHT_BACKEND_SECRET,
      secret: true,
      requiredWhenDeployed: true,
    },
    {
      name: "MIDNIGHT_CLEAN_SEED",
      value: process.env.MIDNIGHT_CLEAN_SEED ?? "",
      isSet: !!process.env.MIDNIGHT_CLEAN_SEED,
      secret: true,
      requiredWhenDeployed: true,
    },
    {
      name: "BATCHER_URL",
      value: process.env.BATCHER_URL || "http://localhost:3334",
      isSet: !!process.env.BATCHER_URL,
      secret: false,
      requiredWhenDeployed: false,
    },
  ];

  const errors = printEnvTable("PVP Arena — Node Environment", entries);

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

export const grammar = {
  midnightContractState: builtinGrammars.midnightGeneric,
  clean_up_game: [
    ["game_id", Type.String()],
  ],
} as const satisfies GrammarDefinition;

export const contractAddress = readMidnightContract(
  "contract-pvp",
  {
    baseDir: path.resolve(import.meta.dirname!, "..", "midnight"),
    networkId: midnightNetworkConfig.id,
  },
).contractAddress;

if (!contractAddress) {
  throw new Error("Counter address not found");
} else {
  console.log("Counter address found:", contractAddress);
}

// ---------------------------------------------------------------------------
// Ledger parser (shared across all environments)
// ---------------------------------------------------------------------------

function decodeCell(av: AlignedValue): number | bigint | string {
  const atom = av.alignment[0];

  // Fallback for option/complex alignment
  if (atom?.tag !== 'atom') return alignedValueToHex(av);

  switch (atom.value.tag) {
    case 'field':
      // Guaranteed valid Fr — safe to use valueToBigInt
      return valueToBigInt(av.value);

    case 'bytes': {
      // Raw LE bytes, possibly split across multiple 31-byte chunks.
      // valueToBigInt will throw here — decode manually instead.
      let result = 0n;
      let shift = 0n;
      for (const chunk of av.value) {
        for (let i = 0; i < chunk.length; i++) {
          result |= BigInt(chunk[i]) << shift;
          shift += 8n;
        }
      }
      return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result;
    }

    case 'compress':
      // Opaque cryptographic hash — no meaningful numeric value
      return alignedValueToHex(av);
  }
}

function alignedValueToHex(av: AlignedValue): string {
  return "0x" + av.value
    .map((chunk: Uint8Array) =>
      Array.from(chunk).map((b) => b.toString(16).padStart(2, "0")).join("")
    )
    .join("");
}

function parseStateValue(sv: StateValue): any {
  const t = sv.type();

  if (t === "null") return null;
  if (t === "cell") return decodeCell(sv.asCell());
  if (t === "array") return sv.asArray()!.map(parseStateValue);

  if (t === "map") {
    const m = sv.asMap()!;
    return Object.fromEntries(
      m.keys().map((k) => [
        alignedValueToHex(k),
        parseStateValue(m.get(k)!)
      ])
    );
  }

  if (t === "boundedMerkleTree") return sv.asBoundedMerkleTree()!.toString(true);

  throw new Error(`Unhandled StateValue type: "${t}"`);
}

export const ledgerParser = (state: StateValue) => parseStateValue(state);

// Shared DB connection — set by apiRouter before any blocks are processed
let dbConn: any = null;

async function waitForDb() {
  while (!dbConn) {
    console.log("Waiting for db connection...");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// Sequential queue: each DB write waits for the previous to finish,
// preventing concurrent writes across consecutive blocks.
let dbQueue = Promise.resolve();

const stm = new Stm<typeof grammar, {}>(grammar);
stm.addStateTransition("midnightContractState", function* (data) {
  // NOTE This will change if there are changes in the contract pvp.compact
  const { payload } = data.parsedInput;
  const game_state = payload["3"][6] as Record<string, number>;

  const game_state_map = {
      0: 'p1_selecting_first_hero', 
      1: 'p2_selecting_first_heroes', 
      2: 'p1_selecting_last_heroes', 
      3: 'p2_selecting_last_hero', 
      4: 'p1_commit', 
      5: 'p2_commit_reveal', 
      6: 'p1_reveal', 
      7: 'p1_win', 
      8: 'p2_win', 
      9: 'tie',
    };

    const three_hours = 3 * 60 * 60 * 1000;

    for (const [key, value] of Object.entries(game_state)) {
      const gameId = key;
      const currentState = game_state_map[value as unknown as keyof typeof game_state_map];

      // Schedule cleanup for newly created games (state 0 = p1_selecting_first_hero)
      if (currentState === 'p1_selecting_first_hero') {
        console.log(`[clean_up_game] New game detected: ${gameId}, scheduling cleanup in 5 minutes`);
        // We need some guard here...
        yield* World.resolve(newScheduledTimestampData, {
          from_address: "0x0",
          from_address_type: AddressType.NONE,
          future_ms_timestamp: new Date(data.blockTimestamp + three_hours),
          input_data: JSON.stringify(["clean_up_game", gameId]),
        });
      }
    }
  

  // Reference of the payload (after adding TIMESTAMP_MAX_AGE, delegations, owner):
  // payload["0"] — state.asArray()[0]
  // [0](internal 600)[1](internal 12)[2]p1_heroes[3]p1_stats[4]p1_cmds[5]p1_stances[6]p1_dmg_0
  //
  // payload["1"] — state.asArray()[1]
  // [0]p1_dmg_1[1]p1_dmg_2[2]p1_commit[3]p2_heroes[4]p2_stats[5]p2_cmds[6]p2_stances[7]p2_dmg_0[8]p2_dmg_1[9]p2_dmg_2[10]p1_alive_0[11]p1_alive_1[12]p1_alive_2[13]p2_alive_0[14]p2_alive_1
  //
  // payload["2"] — state.asArray()[2]
  // [0]p2_alive_2[1]base_damage_cache_p1_0_0[2]base_damage_cache_p1_0_1[3]base_damage_cache_p1_0_2[4]base_damage_cache_p1_1_0[5]base_damage_cache_p1_1_1[6]base_damage_cache_p1_1_2[7]base_damage_cache_p1_2_0[8]base_damage_cache_p1_2_1[9]base_damage_cache_p1_2_2[10]base_damage_cache_p2_0_0[11]base_damage_cache_p2_0_1[12]base_damage_cache_p2_0_2[13]base_damage_cache_p2_1_0[14]base_damage_cache_p2_1_1
  //
  // payload["3"] — state.asArray()[3]
  // [0]base_damage_cache_p2_1_2[1]base_damage_cache_p2_2_0[2]base_damage_cache_p2_2_1[3]base_damage_cache_p2_2_2[4]commit_nonce[5]round[6]game_state[7]p1_public_key[8]p2_public_key[9]public_[10]is_practice[11]last_move_at[12]TIMESTAMP_MAX_AGE[13]delegations[14]owner

  // Example payload:
  //   payload: {
  //     "0": [
  //       600,
  //       12,
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {}
  //     ],
  //     "1": [
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 65793,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 65793
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {},
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {},
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 65793,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 65793
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 1,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 1
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 1,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 1
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 1,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 1
  //       }
  //     ],
  //     "2": [
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 1,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 1
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 1,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 1
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 1,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 1
  //       },
  //       {},
  //       {},
  //       {},
  //       {},
  //       {},
  //       {},
  //       {},
  //       {},
  //       {},
  //       {},
  //       {},
  //       {}
  //     ],
  //     "3": [
  //       {},
  //       {},
  //       {},
  //       {},
  //       {},
  //       {},
  //       {},
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": "4611689071735538560854677883043658026309498247298717974496808757207201633797",
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": "9836755165736853202422971897605447363240842702078111720525461522160739902198"
  //       },
  //       {},
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 1
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 0,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 0
  //       },
  //       {
  //         "0x6cd67a122bd571f2acfc37868c15de9a54ed43e2eb101d6b9df178828601026d": 1773155022,
  //         "0x89671c951f59d37a037ce0df57aea1b3f736ff970bac965e2012729ac15b3d37": 1773155022
  //       },
  //       180
  //     ]
  //   }
  // }

  // delegations is at payload["3"][13] (see layout above)

  try {
    yield* World.promise(waitForDb());
    dbQueue = dbQueue
      .then(async () => {
        const t0 = performance.now();
        await processLedgerSnapshot(dbConn, payload);
        // Process delegation map — located after TIMESTAMP_MAX_AGE in the ledger
        const delegationsMap = payload["3"]?.[13] as Record<string, string> | undefined;
        if (delegationsMap && typeof delegationsMap === 'object') {
          await processDelegations(dbConn, delegationsMap);
        }
        const elapsed = (performance.now() - t0).toFixed(1);
        console.log(`[ledger] block processed in ${elapsed}ms (${Object.keys(game_state).length} matches)`);
      })
      .catch((err) => {
        console.error("[leaderboard] processLedgerSnapshot failed:", err);
      });
  } catch (err) {
    console.error("[leaderboard] processLedgerSnapshot failed:", err);
  }
});

async function getLedgerData(game_id: string): Promise<{ rows: Array<{ has_ledger_data: boolean }> }> {
  const result = await dbConn.query(
    `SELECT has_ledger_data FROM pvp_matches WHERE match_id = $1`,
    [game_id],
  ) as { rows: Array<{ has_ledger_data: boolean }> };
  return result;
}

async function markAsCleanedUp(game_id: string): Promise<void> {
  await dbConn.query(
    `UPDATE pvp_matches SET has_ledger_data = FALSE WHERE match_id = $1`,
    [game_id],
  );
}

stm.addStateTransition("clean_up_game", function* (data) {
  const { game_id } = data.parsedInput;
  setTimeout(async () => {
    // Spawn cleanup script in a fully isolated setTimeout / try-catch
    try {
      console.log(`[clean_up_game] Scheduled cleanup fired for game_id: ${game_id}`);
  
      await waitForDb();
  
      // Check if match still has ledger data to clean up
      const { rows } = await getLedgerData(game_id);
      if (rows.length === 0 || !rows[0].has_ledger_data) {
        console.log(`[clean_up_game] game_id=${game_id} already cleaned up or not found, skipping`);
        return;
      }

      // Mark as cleaned up immediately to prevent duplicate runs
      await markAsCleanedUp(game_id);

      
      const scriptPath = path.resolve(import.meta.dirname!, "..", "midnight", "contract-pvp-cleanup.ts");
      const child = spawn("bun", ["run", scriptPath, game_id], {
        env: {
          ...process.env,
          MIDNIGHT_BACKEND_SECRET: process.env.MIDNIGHT_BACKEND_SECRET || "",
          MIDNIGHT_CLEAN_SEED: process.env.MIDNIGHT_CLEAN_SEED || "",
          MIDNIGHT_NETWORK_ID: process.env.MIDNIGHT_NETWORK_ID || "",
          BATCHER_URL: process.env.BATCHER_URL || "",
        },
        stdio: "inherit",
      });
      child.on("close", (code) => {
        if (code === 0) {
          console.log(`[clean_up_game] cleanup script succeeded for game_id=${game_id}`);
        } else {
          console.error(`[clean_up_game] cleanup script exited with code ${code} for game_id=${game_id}`);
        }
      });
      child.on("error", (err) => {
        console.error(`[clean_up_game] cleanup script status error for game_id=${game_id}:`, err);
      });
    } catch (err) {
      console.error(`[clean_up_game] failed to spawn cleanup script for game_id=${game_id}:`, err);
    }
  }, 0);
});

export const gameStateTransitions: StartConfigGameStateTransitions = function* (
  _blockHeight: number,
  input: BaseStfInput,
): SyncStateUpdateStream<void> {
  yield* stm.processInput(input);
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const apiRouter: StartConfigApiRouter = async function (
  server: any,
  db: any,
): Promise<void> {
  dbConn = db;
  await ensureTables(db);

  // --- existing primitive accounting endpoint ---
  server.get("/fetch-primitive-accounting", async () => {
    const result = await db.query(`SELECT * FROM effectstream.primitive_accounting`);
    return result.rows;
  });

  // --- GET /metrics ---
  server.get("/metrics", async () => {
    return {
      name: "PVP Arena",
      description: "Blockchain turn-based battle game on the Midnight Network.",
      achievements: [],
      channels: [
        {
          id: "leaderboard",
          name: "Wins",
          description: "Total match wins per player.",
          scoreUnit: "Wins",
          sortOrder: "DESC",
        },
      ],
    };
  });

  // --- GET /metrics/leaderboard ---
  server.get("/metrics/leaderboard", async (request: any) => {
    const { startDate, endDate, limit, offset } = request.query ?? {};
    return getLeaderboard(db, {
      startDate,
      endDate,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
    });
  });

  // --- GET /metrics/users/:address ---
  server.get("/metrics/users/:address", async (request: any) => {
    const { address } = request.params;
    const { channel, startDate, endDate } = request.query ?? {};

    const now = new Date();
    const resolvedEnd = endDate ?? now.toISOString();
    const resolvedStart = startDate ?? new Date(now.getTime() - ONE_YEAR_MS).toISOString();

    const identity = await resolveUserIdentity(db, address);
    const achievements = await getUserAchievements(db, address);

    const response: Record<string, any> = { identity, achievements };

    if (!channel) return response;

    const channels: Record<string, any> = {};
    const channelList: string[] = Array.isArray(channel) ? channel : [channel];

    for (const ch of channelList) {
      if (ch === "leaderboard") {
        const stats = await getUserLeaderboardStats(db, address, resolvedStart, resolvedEnd);
        channels["leaderboard"] = {
          startDate: resolvedStart,
          endDate: resolvedEnd,
          stats: stats ?? { score: 0, rank: 0, matchesPlayed: 0 },
        };
      }
    }

    response.channels = channels;
    return response;
  });
};

// ---------------------------------------------------------------------------
// Node startup — called by env-specific entry points (main.dev.ts, etc.)
// ---------------------------------------------------------------------------

export function startNode(envConfig: any): void {
  main(function* () {
    yield* init();
    console.log("Starting EffectStream Node");

    yield* withEffectstreamStaticConfig(envConfig, function* () {
      yield* start({
        appName: "pvp-arena",
        appVersion: "1.0.0",
        syncInfo: toSyncProtocolWithNetwork(envConfig),
        gameStateTransitions,
        migrations: undefined,
        apiRouter,
        grammar,
      });
    });

    yield* suspend();
  });
}
