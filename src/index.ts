/**
 * @vibecontrols/vibe-plugin-session-manager
 *
 * Unified session manager plugin for VibeControls Agent.
 * Provides capability discovery, feature negotiation, and provider routing
 * across all registered session providers (tmux, wezterm, zellij, etc.).
 *
 * Migrated to consume @vibecontrols/plugin-sdk@2026.509.1 — inline contract
 * stubs replaced with SDK imports; provider registry access goes through
 * the SDK ProviderRegistry façade.
 */

import { Elysia, t } from "elysia";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HostServices,
  ProfileContext,
  VibePlugin,
  VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";
import { createLifecycleHooks } from "@vibecontrols/plugin-sdk/lifecycle";
import { BoundLogger } from "@vibecontrols/plugin-sdk/log";
import { ProviderRegistry } from "@vibecontrols/plugin-sdk/providers";

import type { SessionProvider } from "./provider.js";
import type { SessionProviderCapabilities } from "./provider.js";
import type { HealthCheckResult, SessionServiceRegistry } from "./types.js";
import { createSessionRoutes } from "./routes.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_NAME = "session-manager";
const PLUGIN_PACKAGE_NAME = "@vibecontrols/vibe-plugin-session-manager";
const PLUGIN_VERSION = getPluginVersion();

function getPluginVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10 && dir && dir !== dirname(dir); i++) {
      const pkgPath = joinPath(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            name?: string;
            version?: string;
          };
          if (
            pkg.name === PLUGIN_PACKAGE_NAME &&
            typeof pkg.version === "string"
          ) {
            return pkg.version;
          }
        } catch {
          /* malformed package.json — keep walking up */
        }
      }
      dir = dirname(dir);
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

// ---------------------------------------------------------------------------
// Feature keys — all valid feature names for negotiation
// ---------------------------------------------------------------------------

const FEATURE_KEYS: ReadonlyArray<
  keyof SessionProviderCapabilities["features"]
> = [
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
  private registry: ProviderRegistry | undefined;
  private log: BoundLogger = new BoundLogger(undefined, PLUGIN_NAME);

  init(hostServices?: HostServices): void {
    this.log = new BoundLogger(hostServices?.logger, PLUGIN_NAME);
    this.registry = new ProviderRegistry(hostServices);
    this.log.info("Session manager initialized");
  }

  /**
   * List all registered session provider plugin names from the host registry.
   */
  private listProviderNames(): string[] {
    if (!this.registry) {
      this.log.warn("No service registry available");
      return [];
    }
    return this.registry.listProviders("session");
  }

  /**
   * Retrieve a session provider by its plugin name.
   */
  private getProvider(pluginName: string): SessionProvider | undefined {
    if (!this.registry) return undefined;
    return this.registry.getProvider<SessionProvider>("session", pluginName);
  }

  /**
   * Get capabilities for all registered session providers.
   */
  getAllCapabilities(): SessionProviderCapabilities[] {
    const names = this.listProviderNames();
    const results: SessionProviderCapabilities[] = [];

    for (const name of names) {
      const provider = this.getProvider(name);
      if (!provider) continue;

      if (provider.getCapabilities) {
        results.push(provider.getCapabilities());
      } else {
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
    const names = this.listProviderNames();
    const results: Array<{
      pluginName: string;
      providerName: string;
      isDefault: boolean;
      health: HealthCheckResult | null;
      capabilities: SessionProviderCapabilities | null;
    }> = [];

    for (const name of names) {
      const provider = this.getProvider(name);
      let health: HealthCheckResult | null = null;
      let capabilities: SessionProviderCapabilities | null = null;

      if (provider) {
        try {
          health = await provider.healthCheck();
        } catch (err) {
          this.log.error("Health check failed for provider", {
            pluginName: name,
            error: String(err),
          });
        }

        if (provider.getCapabilities) {
          capabilities = provider.getCapabilities();
        }
      }

      results.push({
        pluginName: name,
        providerName: provider?.name ?? name,
        // SDK registry doesn't track default-provider election; agents that
        // need this can fall back to first-registered.
        isDefault: false,
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
        const capabilities = manager.getCapabilitiesForProvider(
          params.provider,
        );
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

/**
 * Plugin Contract v2 factory. Per-profile state (the SessionManager
 * instance) lives in this closure so concurrent profiles cannot share
 * a manager across ProfileContexts.
 */
export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  const manager = new SessionManager();

  // Rich agent ServiceRegistry, captured at onInit (which fires on
  // onServerStart — AFTER createRoutes). The session-operation handlers read
  // it lazily at request time through this proxy, so createRoutes() can close
  // over a stable object even though the registry isn't ready at mount time.
  // Mirrors the tunnel meta's manager.init(host.serviceRegistry) cast.
  let richRegistry: SessionServiceRegistry | undefined;
  const requireRegistry = (): SessionServiceRegistry => {
    if (!richRegistry) {
      throw new Error("Session manager registry not initialized");
    }
    return richRegistry;
  };
  const lazyRegistry: SessionServiceRegistry = {
    getProvider<T>(type: string): T | undefined {
      return requireRegistry().getProvider<T>(type);
    },
    getProviderByName<T>(type: string, pluginName: string): T | undefined {
      return requireRegistry().getProviderByName<T>(type, pluginName);
    },
    listProvidersForType(type: string) {
      return requireRegistry().listProvidersForType(type);
    },
    setProviderDefault(type: string, pluginName: string) {
      requireRegistry().setProviderDefault?.(type, pluginName);
    },
  };

  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "session.meta.ready",
    onInit: async (hostServices) => {
      manager.init(hostServices);
      richRegistry = hostServices.serviceRegistry as unknown as
        | SessionServiceRegistry
        | undefined;
      registerStatusContributors(hostServices);
    },
  });

  return {
    capabilities: {
      storage: "rw",
      subprocess: true,
      broadcast: true,
      audit: true,
      telemetry: true,
    },
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "Unified session manager — capability discovery, feature negotiation, and provider routing across session providers",
    tags: ["backend", "cli", "provider", "integration"],
    // This meta now owns the full session-operations surface (the agent no
    // longer ships a core `session` plugin). Capability discovery + feature
    // negotiation move under `/api/sessions/manager/*`.
    apiPrefix: "/api/sessions",

    metaProviders: [
      {
        packageName: "@vibecontrols/vibe-plugin-session-tmux",
        pluginName: "session-tmux",
        defaultOn: ["linux", "darwin"],
        providerType: "session",
      },
      {
        packageName: "@vibecontrols/vibe-plugin-session-wezterm",
        pluginName: "session-wezterm",
        defaultOn: ["win32"],
        providerType: "session",
      },
      {
        packageName: "@vibecontrols/vibe-plugin-session-zellij",
        pluginName: "session-zellij",
        providerType: "session",
      },
    ],

    createRoutes() {
      // Session operations at the prefix root (1:1 with the former agent-core
      // `/api/sessions` plugin), capability discovery/negotiation nested under
      // `/manager/*`. Mounting the static `/manager` group first keeps it from
      // ever being shadowed by the operations' `/:id` param route.
      return new Elysia()
        .group("/manager", (app) =>
          app.use(createSessionManagerRoutes(manager)),
        )
        .use(createSessionRoutes(lazyRegistry));
    },

    onCliSetup(_program: unknown, hostServices: HostServices): void {
      registerStatusContributors(hostServices);
    },

    onServerStart: lifecycle.onServerStart,
    onServerStop: lifecycle.onServerStop,
    onServerReady(_app: unknown, hostServices?: HostServices) {
      // Contribute a context provider so the LLM Context feature can list
      // installed session providers + recent activity. Late-import keeps
      // the plugin tolerant of older SDK versions that predate the
      // /context subpath.
      void (async () => {
        try {
          const sdkContext =
            (await import("@vibecontrols/plugin-sdk/context")) as {
              registerContextProvider?: (provider: {
                name: string;
                timeoutMs?: number;
                getContext: () => Promise<{
                  pluginName: string;
                  description?: string;
                  data: Record<string, unknown>;
                }>;
              }) => void;
            };
          sdkContext.registerContextProvider?.({
            name: "session-manager",
            timeoutMs: 800,
            async getContext() {
              const reg = hostServices?.serviceRegistry;
              const providerEntries =
                reg?.listProvidersForType?.("session") ?? [];
              const providerNames = providerEntries.map((e) =>
                typeof e === "string" ? e : e.pluginName,
              );
              return {
                pluginName: "session-manager",
                description:
                  "Session orchestration plugin — currently registered session providers + metadata.",
                data: {
                  pluginVersion: PLUGIN_VERSION,
                  providers: providerNames,
                  count: providerNames.length,
                },
              };
            },
          });
        } catch {
          // SDK doesn't support context yet — silently skip
        }
      })();
    },
  };
};

function registerStatusContributors(hostServices?: HostServices): void {
  const reg = hostServices?.cliContributors;
  if (!reg) return;

  reg.addStatusSection?.({
    source: PLUGIN_NAME,
    title: "Sessions",
    render: async ({ agentUrl }: { agentUrl: string }) => {
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
    json: async ({ agentUrl }: { agentUrl: string }) => {
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

  reg.addDoctorCheck?.({
    source: PLUGIN_NAME,
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

export default createPlugin;
export type * from "./provider.js";
export type * from "./types.js";
export type { VibePlugin, HostServices };
