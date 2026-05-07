/**
 * Session-routes-only types — re-export of `provider.ts` plus
 * structurally-typed agent surfaces (PluginRouteDeps, TunnelProvider,
 * ServiceRegistryLike) so the merged session routes can drop in without
 * importing agent source.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type { SessionProvider } from "./provider.js";
export type {
  SessionConfig,
  SessionInfo,
  SessionStatus,
  TerminalInfo,
  HealthCheckResult,
  SystemSessionInfo,
  SystemTerminalInfo,
} from "./types.js";

export interface TunnelProvider {
  readonly name: string;
  getActiveTunnelUrl?(): Promise<string | null>;
}

export interface ServiceRegistryLike {
  registerService?(
    pluginName: string,
    serviceName: string,
    service: unknown,
  ): void;
  getProvider<T>(type: string): T | undefined;
  getProviderByName<T>(type: string, name: string): T | undefined;
  listProvidersForType(
    type: string,
  ): Array<{ pluginName: string; isDefault: boolean }>;
}

export interface PluginRouteDeps {
  db: any;
  serviceRegistry: ServiceRegistryLike;
  pluginManager?: any;
  broadcast?: (type: string, payload: unknown) => void;
  hostServices?: any;
  app?: any;
}
