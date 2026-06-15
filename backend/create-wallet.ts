#!/usr/bin/env bun
/**
 * Creates a new Midnight wallet and prints its shielded address.
 *
 * Usage:
 *   MIDNIGHT_NETWORK_ID=preprod bun run backend/create-wallet.ts
 *   MIDNIGHT_NETWORK_ID=undeployed bun run backend/create-wallet.ts
 *
 * Env vars:
 *   MIDNIGHT_NETWORK_ID  — "undeployed" | "preprod" | "testnet" | "mainnet" (default: "undeployed")
 */

import * as bip39 from "npm:@scure/bip39@1";
import { wordlist as english } from "npm:@scure/bip39@1/wordlists/english";
import { Buffer } from "node:buffer";
import { setNetworkId } from "npm:@midnight-ntwrk/midnight-js-network-id@4.0.0-rc.2";

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import {
  buildWalletFacade,
  getInitialShieldedState,
} from "@effectstream/midnight-contracts";

async function createWallet() {
  const networkId = midnightNetworkConfig.id;
  setNetworkId(networkId);

  const network = {
    indexer: midnightNetworkConfig.indexer,
    indexerWS: midnightNetworkConfig.indexerWS,
    node: midnightNetworkConfig.node,
    proofServer: midnightNetworkConfig.proofServer,
  };

  // Generate mnemonic and derive seed
  const mnemonic = bip39.generateMnemonic(english, 256);
  const seedBytes = await bip39.mnemonicToSeed(mnemonic);
  const seed = Buffer.from(seedBytes).toString("hex");

  // Build wallet facade to derive addresses
  const result = await buildWalletFacade(network, seed, networkId);
  const shieldedState = await getInitialShieldedState(result.wallet.shielded);

  const addresses = {
    shielded: shieldedState.address.coinPublicKeyString(),
    unshielded: result.unshieldedAddress,
    dust: result.dustAddress,
  };

  await result.wallet.stop();

  console.log(JSON.stringify({
    network: networkId,
    mnemonic,
    seed,
    addresses,
  }, null, 2));
}

await createWallet();
