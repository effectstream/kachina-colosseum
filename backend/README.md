# Backend

EffectStream sync node, Midnight contract tooling, and transaction batcher.

## Quick start

From the **repository root**:

```sh
bun install
bun run build:midnight   # first time, or after contract changes
bun run dev
```

Typecheck:

```sh
bun run check
```

## Midnight scripts

Run from the repo root via the midnight-contracts workspace package:

```sh
bun run --filter @pvp-arena-backend/midnight-contracts contract-pvp:deploy:dev
bun run --filter @pvp-arena-backend/midnight-contracts contract-pvp:initialize:dev
bun run --filter @pvp-arena-backend/midnight-contracts faucet
```

## Expected logs

When syncing, you should see effectstream blocks being produced:

```
INFO   effectstream-sync: [Midnight:undeployed] Fetching blocks from 11 to 11.
INFO   effectstream-sync-block-merge: finalized block 26 @ 0x62909d...
```
