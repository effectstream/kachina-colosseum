export class ConfigBuilder {
  [key: string]: any;
  setNamespace(fn: any): any;
  buildNetworks(fn: any): any;
  buildDeployments(fn: any): any;
  buildSyncProtocols(fn: any): any;
  buildPrimitives(fn: any): any;
  build(): any;
}

export const ConfigNetworkType: any;
export const ConfigSyncProtocolType: any;

export type SyncProtocolWithNetwork = any;

export function toSyncProtocolWithNetwork(config: any): SyncProtocolWithNetwork;

export function withEffectstreamStaticConfig<T>(
  config: any,
  fn: () => any,
): any;
