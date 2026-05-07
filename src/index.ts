/**
 * @burdenoff/vibe-plugin-session-manager
 *
 * Unified session manager plugin for VibeControls Agent.
 * Provides capability discovery, feature negotiation, and provider routing
 * across all registered session providers (tmux, wezterm, zellij, etc.).
 */

import { Elysia, t } from "elysia";

import type { SessionProvider } from "./provider.js";
import type {
  SessionProviderCapabilities,
} from "./provider.js";
import type { HealthCheckResult } from "./types.js";

// ---------------------------------------------------------------------------
// HostServices — provided by the vibe-agent runtime at plugin load
// ---------------------------------------------------------------------------

interface HostLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

interface ServiceRegistry {
  registerService(
    pluginName: string,
    serviceName: string,
    service: unknown,
  ): void;
  getProviderByName<T>(type: string, name: string): T | undefined;
  listProvidersForType(
    type: string,
  ): Array<{ pluginName: string; isDefault: boolean }>;
}

interface CliContributorRegistryLike {
  addStatusSection(section: {
    source: string;
    title: string;
    render: (ctx: { agentUrl: string }) => Promise<string | null>;
    json?: (ctx: { agentUrl: string }) => Promise<unknown>;
    jsonKey?: string;
  }): void;
  addDoctorCheck(check: {
    source: string;
    run: () => Promise<
      Array<{
        name: string;
        ok: boolean;
        grade?: "warn";
        message: string;
        hint?: string;
      }>
    >;
  }): void;
}

interface HostServices {
  logger?: {
    info(source: string, msg: string): void;
    warn(source: string, msg: string): void;
    error(source: string, msg: string): void;
    debug(source: string, msg: string): void;
  };
  config?: Record<string, unknown>;
  serviceRegistry?: ServiceRegistry;
  cliContributors?: CliContributorRegistryLike;
}

// ---------------------------------------------------------------------------
// VibePlugin interface
// ---------------------------------------------------------------------------

interface VibePlugin {
  name: string;
  version: string;
  description: string;
  tags?: Array<
    "backend" | "frontend" | "cli" | "provider" | "adapter" | "integration"
  >;
  cliCommand?: string;
  apiPrefix?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createRoutes?: () => any;
  onCliSetup?: (program: unknown, hostServices?: HostServices) => void;
  onServerStart?: (app: unknown, hostServices?: HostServices) => void;
  onServerReady?: (app: unknown, hostServices?: HostServices) => void;
  onServerStop?: () => void;
}

// ---------------------------------------------------------------------------
// Feature keys — all valid feature names for negotiation
// ---------------------------------------------------------------------------

const FEATURE_KEYS: ReadonlyArray<keyof SessionProviderCapabilities["features"]> = [
  "mouse",
  "resize",
  "capture",
  "webTerminal",
  "splitPanes",
  "tabs",
  "scrollback",
  "clipboard",
  "search",
] as const;

// ---------------------------------------------------------------------------
// SessionManager — core logic
// ---------------------------------------------------------------------------

class SessionManager {
  private registry: ServiceRegistry | undefined;
  private log: HostLogger;

  constructor() {
    this.log = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }

  init(hostServices?: HostServices): void {
    if (hostServices?.logger) {
      const source = "session-manager";
      const logger = hostServices.logger;
      this.log = {
        info: (msg, meta) => logger.info(source, meta ? `${msg} ${JSON.stringify(meta)}` : msg),
        warn: (msg, meta) => logger.warn(source, meta ? `${msg} ${JSON.stringify(meta)}` : msg),
        error: (msg, meta) => logger.error(source, meta ? `${msg} ${JSON.stringify(meta)}` : msg),
        debug: (msg, meta) => logger.debug(source, meta ? `${msg} ${JSON.stringify(meta)}` : msg),
      };
    }
    this.registry = hostServices?.serviceRegistry;
    this.log.info("Session manager initialized");
  }

  /**
   * List all registered session provider entries from the service registry.
   */
  private listProviderEntries(): Array<{ pluginName: string; isDefault: boolean }> {
    if (!this.registry) {
      this.log.warn("No service registry available");
      return [];
    }
    return this.registry.listProvidersForType("session");
  }

  /**
   * Retrieve a session provider by its plugin name.
   */
  private getProvider(pluginName: string): SessionProvider | undefined {
    if (!this.registry) return undefined;
    return this.registry.getProviderByName<SessionProvider>("session", pluginName);
  }

  /**
   * Get capabilities for all registered session providers.
   */
  getAllCapabilities(): SessionProviderCapabilities[] {
    const entries = this.listProviderEntries();
    const results: SessionProviderCapabilities[] = [];

    for (const entry of entries) {
      const provider = this.getProvider(entry.pluginName);
      if (!provider) continue;

      if (provider.getCapabilities) {
        results.push(provider.getCapabilities());
      } else {
        // Provider does not implement getCapabilities — return a minimal record
        results.push({
          provider: provider.name,
          features: {
            mouse: false,
            resize: false,
            capture: false,
            webTerminal: false,
            splitPanes: false,
            tabs: false,
            scrollback: false,
            clipboard: false,
            search: false,
          },
          platform: [],
        });
      }
    }

    return results;
  }

  /**
   * Get capabilities for a specific provider by name.
   */
  getCapabilitiesForProvider(
    providerName: string,
  ): SessionProviderCapabilities | null {
    const all = this.getAllCapabilities();
    return all.find((c) => c.provider === providerName) ?? null;
  }

  /**
   * Negotiate: given a list of desired feature names, find the best provider.
   * "Best" = the provider that supports the most desired features.
   * Returns the best match, list of supported/unsupported features, and all
   * candidates sorted by score.
   */
  negotiate(desiredFeatures: string[]): {
    bestProvider: string | null;
    supported: string[];
    unsupported: string[];
    candidates: Array<{
      provider: string;
      score: number;
      supported: string[];
      unsupported: string[];
    }>;
  } {
    const all = this.getAllCapabilities();

    if (all.length === 0) {
      return {
        bestProvider: null,
        supported: [],
        unsupported: desiredFeatures,
        candidates: [],
      };
    }

    // Validate desired features against known keys
    const validFeatures = desiredFeatures.filter((f) =>
      FEATURE_KEYS.includes(f as keyof SessionProviderCapabilities["features"]),
    );

    const candidates = all.map((cap) => {
      const supported: string[] = [];
      const unsupported: string[] = [];

      for (const feature of validFeatures) {
        const key = feature as keyof SessionProviderCapabilities["features"];
        if (cap.features[key]) {
          supported.push(feature);
        } else {
          unsupported.push(feature);
        }
      }

      return {
        provider: cap.provider,
        score: supported.length,
        supported,
        unsupported,
      };
    });

    // Sort by score descending, then alphabetically for tie-breaking
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.provider.localeCompare(b.provider);
    });

    const best = candidates[0];

    return {
      bestProvider: best ? best.provider : null,
      supported: best ? best.supported : [],
      unsupported: best ? best.unsupported : [],
      candidates,
    };
  }

  /**
   * List all registered session providers with their status from healthCheck.
   */
  async listProviders(): Promise<
    Array<{
      pluginName: string;
      providerName: string;
      isDefault: boolean;
      health: HealthCheckResult | null;
      capabilities: SessionProviderCapabilities | null;
    }>
  > {
    const entries = this.listProviderEntries();
    const results: Array<{
      pluginName: string;
      providerName: string;
      isDefault: boolean;
      health: HealthCheckResult | null;
      capabilities: SessionProviderCapabilities | null;
    }> = [];

    for (const entry of entries) {
      const provider = this.getProvider(entry.pluginName);
      let health: HealthCheckResult | null = null;
      let capabilities: SessionProviderCapabilities | null = null;

      if (provider) {
        try {
          health = await provider.healthCheck();
        } catch (err) {
          this.log.error("Health check failed for provider", {
            pluginName: entry.pluginName,
            error: String(err),
          });
        }

        if (provider.getCapabilities) {
          capabilities = provider.getCapabilities();
        }
      }

      results.push({
        pluginName: entry.pluginName,
        providerName: provider?.name ?? entry.pluginName,
        isDefault: entry.isDefault,
        health,
        capabilities,
      });
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function createSessionManagerRoutes(manager: SessionManager) {
  return new Elysia()
    .get("/capabilities", () => {
      const capabilities = manager.getAllCapabilities();
      return { providers: capabilities, count: capabilities.length };
    })
    .get(
      "/capabilities/:provider",
      ({ params }) => {
        const capabilities = manager.getCapabilitiesForProvider(params.provider);
        if (!capabilities) {
          return {
            error: `Provider "${params.provider}" not found or has no capabilities`,
          };
        }
        return capabilities;
      },
      {
        params: t.Object({
          provider: t.String(),
        }),
      },
    )
    .post(
      "/negotiate",
      ({ body }) => {
        return manager.negotiate(body.desiredFeatures);
      },
      {
        body: t.Object({
          desiredFeatures: t.Array(t.String()),
        }),
      },
    )
    .get("/providers", async () => {
      const providers = await manager.listProviders();
      return { providers, count: providers.length };
    });
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const manager = new SessionManager();

export const vibePlugin: VibePlugin = {
  name: "session-manager",
  version: "2026.329.1",
  description:
    "Unified session manager — capability discovery, feature negotiation, and provider routing across session providers",
  tags: ["backend", "integration"],
  apiPrefix: "/api/session-manager",

  createRoutes() {
    return createSessionManagerRoutes(manager);
  },

  onCliSetup(_program: unknown, hostServices?: HostServices): void {
    registerStatusContributors(hostServices);
  },

  onServerStart(_app: unknown, hostServices?: HostServices): void {
    manager.init(hostServices);
    registerStatusContributors(hostServices);
  },
};

function registerStatusContributors(hostServices?: HostServices): void {
  const reg = hostServices?.cliContributors;
  if (!reg) return; // older agent without contributor registry — graceful no-op

  reg.addStatusSection({
    source: "session-manager",
    title: "Sessions",
    render: async ({ agentUrl }) => {
      try {
        const res = await fetch(`${agentUrl}/api/sessions`);
        if (!res.ok) return null;
        const list = (await res.json()) as unknown;
        if (!Array.isArray(list)) return "\x1b[2m(unable to fetch)\x1b[22m";
        if (list.length === 0) return "\x1b[2m(none)\x1b[22m";
        return `\x1b[32m${list.length} active\x1b[39m`;
      } catch {
        return null;
      }
    },
    json: async ({ agentUrl }) => {
      try {
        const res = await fetch(`${agentUrl}/api/sessions`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
    jsonKey: "sessions",
  });

  reg.addDoctorCheck({
    source: "session-manager",
    run: async () => {
      try {
        const port = (process.env.AGENT_URL ?? "http://localhost:3005").replace(
          /\/+$/,
          "",
        );
        const res = await fetch(`${port}/api/sessions`);
        if (!res.ok) {
          return [
            {
              name: "Session manager",
              ok: false,
              grade: "warn" as const,
              message: `/api/sessions returned ${res.status}`,
            },
          ];
        }
        const list = (await res.json()) as unknown;
        if (!Array.isArray(list)) {
          return [
            {
              name: "Session manager",
              ok: false,
              grade: "warn" as const,
              message: "/api/sessions did not return an array",
            },
          ];
        }
        return [
          {
            name: "Session manager",
            ok: true,
            message: `${list.length} active session(s)`,
          },
        ];
      } catch {
        return [];
      }
    },
  });
}

export default vibePlugin;
export type * from "./provider.js";
export type * from "./types.js";
export type { VibePlugin, HostServices };
