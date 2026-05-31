/**
 * Session-related domain types used by SessionProvider implementations.
 */

export interface SessionConfig {
  id?: string;
  name: string;
  command?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  shell?: string;
  size?: { cols: number; rows: number };
  projectId?: string;
  /**
   * Provider-native session name (e.g. tmux session name, wezterm
   * workspace, zellij session). When provided:
   *   - If a matching daemon-side session already exists, the
   *     provider must adopt it instead of creating a new one.
   *   - Otherwise the provider creates with this exact name (no
   *     `vibe-<id>` mangling) so reconnects from another tool keep
   *     working.
   * Optional. Length-bounded by the provider.
   */
  externalName?: string;
}

export type SessionStatus = "active" | "inactive" | "terminated" | "error";

export interface TerminalInfo {
  url: string;
  port: number;
  pid: number;
  /**
   * Loopback host the terminal server listens on. The agent's terminal proxy
   * connects here. Defaults to `127.0.0.1` when the provider omits it.
   */
  host?: string;
  /**
   * WebSocket path the terminal server exposes for the live PTY stream, e.g.
   * `/ws`. The agent proxies the browser WS to `ws://{host}:{port}{wsPath}`
   * WITHOUT assuming any particular terminal backend. Defaults to `/ws`.
   */
  wsPath?: string;
  /**
   * WebSocket subprotocols the terminal server negotiates (e.g. `["tty"]` for
   * ttyd). The agent forwards these verbatim, so it never hardcodes a
   * provider-specific subprotocol. Defaults to `["tty"]`.
   */
  subprotocols?: string[];
}

export interface SessionInfo {
  id: string;
  name: string;
  status: SessionStatus;
  provider: string;
  command?: string;
  workingDirectory?: string;
  pid?: number;
  projectId?: string;
  createdAt: string;
  updatedAt?: string;
  terminal?: TerminalInfo;
  metadata?: Record<string, unknown>;
}

export interface HealthCheckResult {
  ok: boolean;
  sessions: number;
  terminals: number;
  message?: string;
}

export interface SystemSessionInfo {
  id: string;
  name: string;
  windows: number;
  attached: boolean;
  createdAt?: string;
}

export interface SystemTerminalInfo {
  pid: number;
  port: number;
  sessionId?: string;
}

/**
 * Structural view of the agent's runtime ServiceRegistry — richer than the
 * SDK's neutral `ServiceRegistry` (provider defaults + `{pluginName,isDefault}`
 * listing). Mirrors the tunnel meta's `TunnelServiceRegistry`. The session
 * routes narrow `host.serviceRegistry` to this via a single cast at the
 * boundary so they can resolve a specific provider by name + the default.
 */
export interface SessionServiceRegistry {
  getProvider<T>(type: string): T | undefined;
  getProviderByName<T>(type: string, pluginName: string): T | undefined;
  listProvidersForType(
    type: string,
  ): Array<{ pluginName: string; isDefault: boolean }>;
  setProviderDefault?(type: string, pluginName: string): void;
}

/**
 * Minimal structural view of a tunnel provider. The session terminal routes
 * only need its active public URL to build the terminal proxy URL, so we avoid
 * a dependency on the tunnel meta's full provider contract.
 */
export interface TunnelProvider {
  getActiveTunnelUrl?(): Promise<string | null>;
}
