export function getEnv(name: string): string | undefined;

export type WalletAddress = any;

export enum AddressType {
  NONE = -1,
  EVM = 0,
  CARDANO = 1,
  SUBSTRATE = 2,
  ALGORAND = 3,
  MINA = 4,
  MIDNIGHT = 5,
  BITCOIN = 6,
  NEAR = 7,
}
