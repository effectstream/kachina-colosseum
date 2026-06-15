# PVP Arena — Kachina Kolosseum

Kachina Kolosseum is a blockchain-based turn-based PvP battle game built on the Midnight Network. Two players face off with teams of 3 heroes in a gladiatorial arena. Game moves are kept private using zero-knowledge proofs — commands are committed on-chain and only revealed after both players have submitted, preventing any front-running or move-snooping.

## Repository Structure

```
kachina-colosseum/
├── package.json            # Bun workspace root (backend + frontend packages)
├── bun.lock
├── frontend/
│   └── src/
│       ├── contract/       # Compact DSL smart contract + compiled ZK output
│       ├── api/            # TypeScript layer for contract interaction (PVPArenaAPI)
│       └── phaser/         # Phaser 3 browser game UI (scenes, wallet, batcher client)
└── backend/
    └── packages/
        ├── midnight/       # Contract deployment, local Midnight chain, faucet
        ├── node/           # EffectStream runtime (syncs on-chain state)
        └── batcher/        # Transaction batcher (Midnight balancing)
```

## Prerequisites

- **Bun** — [https://bun.sh](https://bun.sh)
- **Compact compiler v0.30.0** — install the correct binaries from Midnight docs

## Local Development

Install dependencies once from the repo root:

```bash
bun install
```

### Terminal 1 — Backend

```bash
bun run build:midnight   # first time, or after contract changes
bun run dev
```

Wait until you see `finalized block {1}`, `finalized block {2}`, … before starting the frontend.

### Terminal 2 — Frontend

```bash
bun run build:frontend   # first time, or after contract/api changes
bun run --filter pvp-phaser dev
```

The game will be available at `http://localhost:5173/`.

## Smart Contract

The game logic lives in a single Compact DSL contract:

- **Backend source** (canonical): [`backend/packages/midnight/contract-pvp/src/pvp.compact`](backend/packages/midnight/contract-pvp/src/pvp.compact)
- **Frontend copy** (compiled from the same file): [`frontend/src/contract/src/pvp.compact`](frontend/src/contract/src/pvp.compact)

### Exposed Circuits (on-chain functions)

#### Match lifecycle

| Circuit | Caller | Description |
|---|---|---|
| `create_new_match(match_nonce, is_match_public, is_match_practice, now)` | P1 | Creates a new match. Derives a unique `match_id` from P1's public key + nonce. Returns the `match_id`. |
| `join_match(now)` | P2 | Joins an existing match (identified by `current_match_id` witness). Registers P2's public key. |
| `close_match()` | P1 or P2 | Closes a match that has not started yet (P1 only), or any practice match. P2 may also force-close if P1 times out during hero selection. Sets state to `tie`. |
| `cleanup_match()` | P1 or P2 | Removes all on-chain ledger entries for a finished match, freeing storage. Only callable once the match is in a terminal state (`p1_win`, `p2_win`, or `tie`). |

#### Hero selection — alternating draft

| Circuit | Caller | Description |
|---|---|---|
| `p1_select_first_hero(first_p1_hero, now)` | P1 | P1 picks their first hero (equipment loadout). |
| `p2_select_first_heroes(all_p2_heroes, now)` | P2 | P2 picks their first two heroes (sees P1's first hero first). |
| `p1_select_last_heroes(last_p1_heroes, now)` | P1 | P1 picks their remaining two heroes (sees P2's two heroes). |
| `p2_select_last_hero(last_hero, now)` | P2 | P2 picks their final hero (sees P1's full team). Triggers full pairwise damage-cache computation. |

#### Combat — commit-reveal per round

| Circuit | Caller | Description |
|---|---|---|
| `p1_commit_commands(nonce, now)` | P1 | P1 privately commits their 3 attack targets + stances as a ZK hash. Commands are never disclosed on-chain at this point. |
| `p2_commit_commands(now)` | P2 | P2 submits their commands publicly (no need to hide since P1 already committed). |
| `p1_reveal_commands(now)` | P1 | P1 reveals their commands. The circuit verifies they match the earlier hash, then resolves all damage, updates alive/dead state, and advances to the next round or sets a winner. |

#### End-of-round outcomes

After `p1_reveal_commands` the contract sets `game_state` to one of:
- `p1_commit` — match continues, next round begins
- `p1_win` / `p2_win` / `tie` — match over

#### Timeout & surrender

| Circuit | Caller | Description |
|---|---|---|
| `claim_timeout_win()` | P1 or P2 | Claims a win if the opponent has not acted within the 10-minute turn timeout. P1 can claim during P2's turns and vice versa. |
| `surrender()` | P1 or P2 | Voluntarily concedes — opponent wins immediately. Only valid during active combat states. |

### Pure Utility Circuits

These are stateless helper functions used by the UI and internally by the combat circuits:

| Circuit | Description |
|---|---|
| `calc_stats(hero)` | Computes a hero's combined `TotalStats` (crush/pierce dmg & def, dex bonus, weight) from their equipment. |
| `calc_item_dmg_against(stats, stance, enemy_stats, enemy_stance)` | Calculates net damage one hero deals to another given both stances. |
| `calc_commit_for_checking(sk, commands, stances, nonce)` | Recomputes a commit hash client-side (for UI to verify a resumed game's commit is still valid). |
| `derive_public_key(sk)` | Derives a player's on-chain public key from their private secret key. |
| `hack_to_hero(hero)` / `hack_to_item(index)` / `hack_to_armor(index)` | Convert integer indices to typed enums (`ITEM`, `ARMOR`, `Hero`). Used because Compact doesn't support passing enums directly from the frontend. |

### Key Types

- **`Hero`** — equipment loadout: `rhs`, `lhs` (weapons), `helmet`, `chest`, `skirt`, `greaves` (armor)
- **`ITEM`** — `nothing`, `axe`, `shield`, `bow`, `sword`, `spear`
- **`ARMOR`** — `nothing`, `leather`, `metal`
- **`STANCE`** — `defensive` (×2 dmg), `neutral` (×5), `aggressive` (×8)
- **`GAME_STATE`** — state machine values driving turn order


## Deploying & Launching in Preprod & Mainnet

```sh
# Start Proof Server
bun run --filter @pvp-arena-backend/midnight-contracts midnight-proof-server:start

# Deploy Contracts
MIDNIGHT_WALLET_MNEMONIC="word1 ... word12" MIDNIGHT_NETWORK_ID=preprod MIDNIGHT_STORAGE_PASSWORD=YourPasswordMy1! \
  bun run --filter @pvp-arena-backend/midnight-contracts contract-pvp:deploy:testnet
```

Once you have the contract address, patch the frontend:

```sh
bun run --filter @pvp-arena-backend/midnight-contracts contract-pvp:patch-frontend:testnet
```

Now you can start the backend service.
If it's the first run, you should set the start block height to the current block height.

```sh
curl -s -X POST \
  'https://indexer.preprod.midnight.network/api/v3/graphql' \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ block { height timestamp } }"}' | jq

> {
  "data": {
    "block": {
      "height": 690163,
      "timestamp": 1773883812000
    }
  }
}
```

and update
```ts
    .addParallel(
        (networks) => (networks as any).midnight,
        (_network, _deployments) => ({
          name: "parallelMidnight",
          type: ConfigSyncProtocolType.MIDNIGHT_PARALLEL,
          startBlockHeight: 690163,
          pollingInterval: 6000,
          delayMs: 0,
          indexer: midnightNetworkConfig.indexer,
          indexerWs: midnightNetworkConfig.indexerWS,
        }),
      )
```

Your DB must be running.

```sh
bun run testnet
```

Frontend (testnet build):

```sh
bun run build:frontend
bun run --filter pvp-phaser build-testnet
bun run --filter pvp-phaser preview
```