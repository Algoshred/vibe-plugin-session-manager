/**
 * Session Plugin — Routes
 *
 * Delegates all session management to the registered SessionProvider.
 * This decouples the API from any specific terminal multiplexer (tmux, wezterm, etc.).
 *
 * Endpoints:
 *   GET    /                          — List all managed sessions
 *   GET    /system                    — List all system sessions (incl. unmanaged)
 *   GET    /system/terminals          — List all system terminal server processes
 *   POST   /system/kill               — Bulk kill system sessions
 *   POST   /system/terminals/kill     — Bulk kill system terminal processes
 *   POST   /health-check              — Bulk session health check
 *   POST   /create                    — Create a new session (idempotent)
 *   GET    /:id                       — Get session by ID
 *   DELETE /:id                       — Kill/terminate session
 *   POST   /:id/command               — Send command to session
 *   POST   /:id/keys                  — Send raw keys to session
 *   POST   /:id/interrupt             — Send Ctrl+C to session
 *   GET    /:id/capture               — Capture session output
 *   PUT    /:id/rename                — Rename session
 *   POST   /:id/toggle-mouse          — Toggle mouse mode
 *   GET    /:id/termination-status    — Get session termination verification
 *   GET    /:id/terminal              — Get terminal info
 *   POST   /:id/terminal              — Start web terminal (ttyd)
 *   POST   /:id/terminal/stop         — Stop web terminal
 */

import { Elysia, t } from "elysia";

import type {
  PluginRouteDeps,
  ServiceRegistryLike as ServiceRegistry,
  SessionProvider,
  TunnelProvider,
} from "./session-types.js";
import { resolveSafePath } from "./utils/safe-paths.js";
import { denyNonLocalMutation } from "./utils/security.js";

// ── Provider name resolution ────────────────────────────────────────────
// Translates a backend session type (TMUX / WEZTERM / ZELLIJ) into the
// pluginName each provider registers under via the catalog the agent
// injects through PluginRouteDeps.integrations.pluginCatalog. The plugin
// stays abstracted from any specific session backend.

interface SessionProviderCatalogEntry {
  category: string;
  pluginName: string;
  sessionBackend?: string;
}

let PLUGIN_CATALOG: SessionProviderCatalogEntry[] = [];

export function setSessionPluginCatalog(
  catalog: SessionProviderCatalogEntry[],
): void {
  PLUGIN_CATALOG = catalog;
}

function resolveSessionProviderPluginName(
  backendHint: string,
): string | undefined {
  const want = backendHint.toLowerCase();
  const entry = PLUGIN_CATALOG.find(
    (p) => p.category === "session" && p.sessionBackend === want,
  );
  return entry?.pluginName;
}

// Tracks which provider owns each session ID so that subsequent
// operations (get, terminal, command, etc.) route to the correct plugin
// regardless of the agent's default provider.
const sessionProviderMap = new Map<string, string>();

const MAX_BULK_TARGETS = 50;
const MAX_SESSION_ID_LENGTH = 200;
const MAX_SESSION_NAME_LENGTH = 120;
const MAX_COMMAND_LENGTH = parseInt(
  process.env.VIBECONTROLS_SESSION_MAX_COMMAND_BYTES ?? `${16 * 1024}`,
  10,
);
const MAX_KEYS_LENGTH = parseInt(
  process.env.VIBECONTROLS_SESSION_MAX_KEYS_BYTES ?? "4096",
  10,
);

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the session provider for a request.
 *
 * Priority:
 *  1. Explicit providerHint (used on create, from backend session.type)
 *  2. Remembered provider for this sessionId (set after create)
 *  3. Try all registered providers to find who owns the session
 *  4. Default provider
 */
function getSessionProvider(
  registry: ServiceRegistry,
  providerHint?: string,
): SessionProvider {
  if (providerHint) {
    const pluginName = resolveSessionProviderPluginName(providerHint);
    if (pluginName) {
      const specific = registry.getProviderByName<SessionProvider>(
        "session",
        pluginName,
      );
      if (specific) return specific;
    }
  }

  const provider = registry.getProvider<SessionProvider>("session");
  if (!provider) {
    throw new Error("No session provider registered");
  }
  return provider;
}

function validateSessionId(id: string): string | null {
  if (!id || id.length > MAX_SESSION_ID_LENGTH || /[\0\r\n]/.test(id)) {
    return "Invalid session id";
  }
  return null;
}

function validateBulkTargets(targets: unknown[]): string | null {
  if (targets.length > MAX_BULK_TARGETS) {
    return `Too many targets (max ${MAX_BULK_TARGETS})`;
  }
  return null;
}

function validateTextBytes(
  value: string,
  maxBytes: number,
  label: string,
): string | null {
  if (/[\0]/.test(value)) return `${label} contains invalid characters`;
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    return `${label} is too large (max ${maxBytes} bytes)`;
  }
  return null;
}

/**
 * Find the provider that owns a given session ID.
 * Checks the in-memory map first, then probes all registered providers.
 */
async function getProviderForSession(
  registry: ServiceRegistry,
  sessionId: string,
): Promise<SessionProvider> {
  // 1. Check remembered mapping
  const remembered = sessionProviderMap.get(sessionId);
  if (remembered) {
    const pluginName = resolveSessionProviderPluginName(remembered);
    if (pluginName) {
      const p = registry.getProviderByName<SessionProvider>(
        "session",
        pluginName,
      );
      if (p) return p;
    }
  }

  // 2. Probe all registered providers
  const allProviders = registry.listProvidersForType("session");
  for (const { pluginName } of allProviders) {
    const p = registry.getProviderByName<SessionProvider>(
      "session",
      pluginName,
    );
    if (p) {
      const session = await p.get(sessionId);
      if (session) {
        // Remember for future calls
        sessionProviderMap.set(sessionId, p.name);
        return p;
      }
    }
  }

  // 3. Fall back to default
  return getSessionProvider(registry);
}

// ── Routes ──────────────────────────────────────────────────────────────

export function createRoutes(deps: PluginRouteDeps) {
  const { serviceRegistry } = deps;

  return (
    new Elysia()
      // List all managed sessions. Terminated sessions are filtered out
      // by default — pass `?includeTerminated=true` to see them. Doctor
      // tests expect a killed session to disappear from the active list.
      .get("/", async ({ query, set }) => {
        try {
          const provider = getSessionProvider(serviceRegistry);
          const q = query as Record<string, string>;
          const includeTerminated = q.includeTerminated === "true";
          const raw =
            q.system === "true"
              ? await provider.listSystem()
              : await provider.list();
          const sessions = includeTerminated
            ? raw
            : raw.filter((s) => {
                const status = (s as { status?: string }).status;
                return status !== "terminated" && status !== "stopped";
              });
          return { sessions };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to list sessions", details: String(err) };
        }
      })

      // List all system sessions (including unmanaged ones)
      .get("/system", async ({ set }) => {
        try {
          const provider = getSessionProvider(serviceRegistry);
          const sessions = await provider.listSystem();
          return { sessions };
        } catch (err) {
          set.status = 500;
          return {
            error: "Failed to get system sessions",
            details: String(err),
          };
        }
      })

      // List all system terminal server processes
      .get("/system/terminals", async ({ set }) => {
        try {
          const provider = getSessionProvider(serviceRegistry);
          const processes = await provider.listSystemTerminals();
          return { processes };
        } catch (err) {
          set.status = 500;
          return {
            error: "Failed to get system terminal processes",
            details: String(err),
          };
        }
      })

      // List `vibe-*` tmux sessions on the host that aren't tracked by the
      // current agent's storage. Returned by SessionProvider.discoverOrphans()
      // when implemented. Used by the UI's "Reconnect tmux sessions" picker
      // so users can recover sessions after an agent reset / storage wipe.
      .get("/orphans", async ({ set }) => {
        try {
          const provider = getSessionProvider(
            serviceRegistry,
          ) as SessionProvider & {
            discoverOrphans?: () => Promise<unknown>;
          };
          if (typeof provider.discoverOrphans !== "function") {
            return { orphans: [] };
          }
          const orphans = await provider.discoverOrphans();
          return { orphans };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to list orphans", details: String(err) };
        }
      })

      // Adopt an orphan tmux session into agent storage. Idempotent.
      .post(
        "/adopt",
        async ({ body, set }) => {
          try {
            const provider = getSessionProvider(
              serviceRegistry,
            ) as SessionProvider & {
              adopt?: (
                tmuxName: string,
                displayName?: string,
              ) => Promise<unknown>;
            };
            if (typeof provider.adopt !== "function") {
              set.status = 400;
              return {
                error: "Active session provider does not support adoption",
              };
            }
            const session = await provider.adopt(
              body.tmuxName,
              body.displayName,
            );
            return { session };
          } catch (err) {
            set.status = 500;
            return { error: "Failed to adopt session", details: String(err) };
          }
        },
        {
          body: t.Object({
            tmuxName: t.String({ minLength: 6, maxLength: 128 }),
            displayName: t.Optional(t.String({ maxLength: 128 })),
          }),
        },
      )

      // Bulk kill system sessions
      .post(
        "/system/kill",
        async ({ body, request, server, set }) => {
          const denied = denyNonLocalMutation(
            request,
            "VIBECONTROLS_ALLOW_REMOTE_SYSTEM_SESSION_KILL",
            server,
          );
          if (denied) {
            set.status = 403;
            return { error: "Forbidden", message: denied };
          }
          const bulkError = validateBulkTargets(body.sessionIds);
          if (bulkError) {
            set.status = 400;
            return { error: bulkError };
          }
          try {
            const provider = getSessionProvider(serviceRegistry);
            const results: Array<{
              target: string;
              success: boolean;
              error?: string;
            }> = [];

            for (const sessionId of body.sessionIds) {
              const idError = validateSessionId(sessionId);
              if (idError) {
                results.push({
                  target: sessionId,
                  success: false,
                  error: idError,
                });
                continue;
              }
              try {
                await provider.killSystem(sessionId);
                results.push({ target: sessionId, success: true });
              } catch (err) {
                results.push({
                  target: sessionId,
                  success: false,
                  error: String(err),
                });
              }
            }

            return { results };
          } catch (err) {
            set.status = 500;
            return {
              error: "Failed to kill system sessions",
              details: String(err),
            };
          }
        },
        {
          body: t.Object({
            sessionIds: t.Array(t.String()),
            force: t.Optional(t.Boolean()),
          }),
        },
      )

      // Bulk kill system terminal processes
      .post(
        "/system/terminals/kill",
        async ({ body, request, server, set }) => {
          const denied = denyNonLocalMutation(
            request,
            "VIBECONTROLS_ALLOW_REMOTE_SYSTEM_TERMINAL_KILL",
            server,
          );
          if (denied) {
            set.status = 403;
            return { error: "Forbidden", message: denied };
          }
          const bulkError = validateBulkTargets(body.pids);
          if (bulkError) {
            set.status = 400;
            return { error: bulkError };
          }
          try {
            const provider = getSessionProvider(serviceRegistry);
            const results: Array<{
              target: string;
              success: boolean;
              error?: string;
            }> = [];

            for (const pid of body.pids) {
              if (!Number.isInteger(pid) || pid <= 0) {
                results.push({
                  target: String(pid),
                  success: false,
                  error: "Invalid pid",
                });
                continue;
              }
              try {
                await provider.killSystemTerminal(pid);
                results.push({ target: String(pid), success: true });
              } catch (err) {
                results.push({
                  target: String(pid),
                  success: false,
                  error: String(err),
                });
              }
            }

            return { results };
          } catch (err) {
            set.status = 500;
            return {
              error: "Failed to kill system terminal processes",
              details: String(err),
            };
          }
        },
        {
          body: t.Object({
            pids: t.Array(t.Number()),
            force: t.Optional(t.Boolean()),
          }),
        },
      )

      // Bulk session health check
      .post(
        "/health-check",
        async ({ body, set }) => {
          try {
            const provider = getSessionProvider(serviceRegistry);
            const targetIds =
              body.sessionIds ??
              (await provider.list()).map((session) => session.id);
            const bulkError = validateBulkTargets(targetIds);
            if (bulkError) {
              set.status = 400;
              return { error: bulkError };
            }
            const results: Array<{
              sessionId: string;
              status: "running" | "dead" | "unknown";
            }> = [];

            for (const sessionId of targetIds) {
              try {
                const session = await provider.get(sessionId);
                if (!session) {
                  results.push({ sessionId, status: "unknown" });
                } else {
                  results.push({
                    sessionId,
                    status: session.status === "active" ? "running" : "dead",
                  });
                }
              } catch {
                results.push({ sessionId, status: "unknown" });
              }
            }

            return {
              results,
              checked: results.length,
              healthy: results.filter((r) => r.status === "running").length,
              fixed: 0,
            };
          } catch (err) {
            set.status = 500;
            return {
              error: "Failed to health check sessions",
              details: String(err),
            };
          }
        },
        {
          body: t.Object({
            sessionIds: t.Optional(t.Array(t.String())),
          }),
        },
      )

      // Create new session (idempotent)
      .post(
        "/create",
        async ({ body, set }) => {
          try {
            const provider = getSessionProvider(serviceRegistry, body.provider);
            const sessionId = body.sessionId;
            if (sessionId) {
              const idError = validateSessionId(sessionId);
              if (idError) {
                set.status = 400;
                return { error: idError };
              }
            }

            const sessionName = body.sessionName ?? body.name;
            if (
              sessionName &&
              (sessionName.length > MAX_SESSION_NAME_LENGTH ||
                /[\0\r\n]/.test(sessionName))
            ) {
              set.status = 400;
              return { error: "Invalid session name" };
            }

            const command = body.command;
            if (command) {
              const commandError = validateTextBytes(
                command,
                MAX_COMMAND_LENGTH,
                "command",
              );
              if (commandError) {
                set.status = 400;
                return { error: commandError };
              }
            }

            const startDirectory = body.startDirectory ?? body.cwd;
            const safeStartDirectory = startDirectory
              ? (await resolveSafePath(startDirectory, { mustExist: true }))
                  .realPath
              : undefined;

            // Check if session already exists (idempotent)
            if (sessionId) {
              const existing = await provider.get(sessionId);
              if (existing && existing.status === "active") {
                return { session: existing, reused: true };
              }
            }

            // Validate optional externalName (provider-native session name).
            // When supplied, providers attach to an existing session of that
            // name instead of generating a fresh one.
            const externalName = body.externalName?.trim() || undefined;
            if (
              externalName &&
              (externalName.length > 128 || /[\0\r\n:.\s]/.test(externalName))
            ) {
              set.status = 400;
              return { error: "Invalid externalName" };
            }

            const session = await provider.create({
              id: sessionId,
              name: sessionName || `vibecontrols-${Date.now()}`,
              command,
              workingDirectory: safeStartDirectory,
              projectId: body.projectId ?? body.project,
              externalName,
            });

            // Remember which provider owns this session
            sessionProviderMap.set(session.id, provider.name);

            return { session, reused: false };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            set.status =
              message.includes("path") || message.includes("Access denied")
                ? 400
                : 500;
            return { error: "Failed to create session", details: message };
          }
        },
        {
          body: t.Object({
            sessionId: t.Optional(t.String()),
            projectId: t.Optional(t.String()),
            project: t.Optional(t.String()),
            sessionName: t.Optional(t.String()),
            name: t.Optional(t.String()),
            windowName: t.Optional(t.String()),
            command: t.Optional(t.String()),
            startDirectory: t.Optional(t.String()),
            cwd: t.Optional(t.String()),
            provider: t.Optional(t.String()),
            externalName: t.Optional(t.String({ maxLength: 128 })),
          }),
        },
      )

      // Get session by ID
      .get("/:id", async ({ params, set }) => {
        const idError = validateSessionId(params.id);
        if (idError) {
          set.status = 400;
          return { error: idError };
        }
        try {
          const provider = await getProviderForSession(
            serviceRegistry,
            params.id,
          );
          const session = await provider.get(params.id);

          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          return { session };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to get session", details: String(err) };
        }
      })

      // Kill session
      .delete("/:id", async ({ params, set }) => {
        const idError = validateSessionId(params.id);
        if (idError) {
          set.status = 400;
          return { error: idError };
        }
        try {
          const provider = await getProviderForSession(
            serviceRegistry,
            params.id,
          );
          const session = await provider.get(params.id);

          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          await provider.kill(params.id);

          return { success: true, sessionName: session.name };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to kill session", details: String(err) };
        }
      })

      // Send command to session
      .post(
        "/:id/command",
        async ({ params, body, set }) => {
          const idError = validateSessionId(params.id);
          const commandError = validateTextBytes(
            body.command,
            MAX_COMMAND_LENGTH,
            "command",
          );
          if (idError || commandError) {
            set.status = 400;
            return { error: idError ?? commandError };
          }
          try {
            const provider = await getProviderForSession(
              serviceRegistry,
              params.id,
            );
            const session = await provider.get(params.id);

            if (!session) {
              set.status = 404;
              return { error: "Session not found" };
            }

            await provider.sendCommand(params.id, body.command);
            return { success: true };
          } catch (err) {
            set.status = 500;
            return { error: "Failed to execute command", details: String(err) };
          }
        },
        {
          body: t.Object({
            command: t.String(),
          }),
        },
      )

      // Send raw keys to session
      .post(
        "/:id/keys",
        async ({ params, body, set }) => {
          const idError = validateSessionId(params.id);
          const keyError = validateTextBytes(
            body.keys,
            MAX_KEYS_LENGTH,
            "keys",
          );
          if (idError || keyError) {
            set.status = 400;
            return { error: idError ?? keyError };
          }
          try {
            const provider = await getProviderForSession(
              serviceRegistry,
              params.id,
            );
            const session = await provider.get(params.id);

            if (!session) {
              set.status = 404;
              return { error: "Session not found" };
            }

            await provider.sendKeys(params.id, body.keys);
            return { success: true };
          } catch (err) {
            set.status = 500;
            return { error: "Failed to send keys", details: String(err) };
          }
        },
        {
          body: t.Object({
            keys: t.String(),
          }),
        },
      )

      // Interrupt session (Ctrl+C)
      .post("/:id/interrupt", async ({ params, set }) => {
        const idError = validateSessionId(params.id);
        if (idError) {
          set.status = 400;
          return { error: idError };
        }
        try {
          const provider = await getProviderForSession(
            serviceRegistry,
            params.id,
          );
          const session = await provider.get(params.id);

          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          await provider.interrupt(params.id);
          return { success: true };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to send interrupt", details: String(err) };
        }
      })

      // Capture session output
      .get("/:id/capture", async ({ params, set }) => {
        const idError = validateSessionId(params.id);
        if (idError) {
          set.status = 400;
          return { error: idError };
        }
        try {
          const provider = await getProviderForSession(
            serviceRegistry,
            params.id,
          );
          const session = await provider.get(params.id);

          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const output = await provider.capture(params.id);
          return { output };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to capture output", details: String(err) };
        }
      })

      // Rename session
      .put(
        "/:id/rename",
        async ({ params, body, set }) => {
          const idError = validateSessionId(params.id);
          if (idError) {
            set.status = 400;
            return { error: idError };
          }
          if (
            body.newName.length > MAX_SESSION_NAME_LENGTH ||
            /[\0\r\n]/.test(body.newName)
          ) {
            set.status = 400;
            return { error: "Invalid session name" };
          }
          try {
            const provider = await getProviderForSession(
              serviceRegistry,
              params.id,
            );
            const session = await provider.get(params.id);

            if (!session) {
              set.status = 404;
              return { error: "Session not found" };
            }

            await provider.rename(params.id, body.newName);
            return { success: true };
          } catch (err) {
            set.status = 500;
            return { error: "Failed to rename session", details: String(err) };
          }
        },
        {
          body: t.Object({
            newName: t.String(),
          }),
        },
      )

      // Toggle mouse mode
      .post("/:id/toggle-mouse", async ({ params, set }) => {
        const idError = validateSessionId(params.id);
        if (idError) {
          set.status = 400;
          return { error: idError };
        }
        try {
          const provider = await getProviderForSession(
            serviceRegistry,
            params.id,
          );
          const session = await provider.get(params.id);

          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          await provider.toggleMouse(params.id);
          return { success: true };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to toggle mouse mode", details: String(err) };
        }
      })

      // Get termination status
      .get("/:id/termination-status", async ({ params, set }) => {
        const idError = validateSessionId(params.id);
        if (idError) {
          set.status = 400;
          return { error: idError };
        }
        try {
          const provider = await getProviderForSession(
            serviceRegistry,
            params.id,
          );
          const session = await provider.get(params.id);

          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const termStatus = await provider.getTerminationStatus(params.id);
          return {
            sessionId: params.id,
            sessionName: session.name,
            databaseStatus: session.status,
            ...termStatus,
            isFullyTerminated:
              termStatus.exited && session.status === "terminated",
          };
        } catch (err) {
          set.status = 500;
          return {
            error: "Failed to verify termination",
            details: String(err),
          };
        }
      })

      // Get terminal info
      .get("/:id/terminal", async ({ params, set }) => {
        const idError = validateSessionId(params.id);
        if (idError) {
          set.status = 400;
          return { error: idError };
        }
        try {
          const provider = await getProviderForSession(
            serviceRegistry,
            params.id,
          );
          const session = await provider.get(params.id);

          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const terminal = await provider.getTerminalInfo(params.id);
          if (!terminal) {
            set.status = 404;
            return { error: "Terminal not running for this session" };
          }

          // Build proxy URL if tunnel is available
          const tunnelProvider =
            serviceRegistry.getProvider<TunnelProvider>("tunnel");
          const tunnelUrl =
            tunnelProvider && tunnelProvider.getActiveTunnelUrl
              ? await tunnelProvider.getActiveTunnelUrl()
              : null;
          const terminalProxyUrl = tunnelUrl
            ? `${tunnelUrl}/terminal/${encodeURIComponent(params.id)}/`
            : null;

          return {
            port: terminal.port,
            url: `http://localhost:${terminal.port}`,
            pid: terminal.pid,
            terminalUrl: terminalProxyUrl,
          };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to get terminal info", details: String(err) };
        }
      })

      // Start web terminal (ttyd)
      .post("/:id/terminal", async ({ params, set }) => {
        const idError = validateSessionId(params.id);
        if (idError) {
          set.status = 400;
          return { error: idError };
        }
        try {
          const provider = await getProviderForSession(
            serviceRegistry,
            params.id,
          );
          const session = await provider.get(params.id);

          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          // Check if terminal is already running
          const existingTerminal = await provider.getTerminalInfo(params.id);
          if (existingTerminal) {
            const tunnelProvider =
              serviceRegistry.getProvider<TunnelProvider>("tunnel");
            const tunnelUrl =
              tunnelProvider && tunnelProvider.getActiveTunnelUrl
                ? await tunnelProvider.getActiveTunnelUrl()
                : null;
            const terminalProxyUrl = tunnelUrl
              ? `${tunnelUrl}/terminal/${encodeURIComponent(params.id)}/`
              : null;

            return {
              port: existingTerminal.port,
              pid: existingTerminal.pid,
              url: `http://localhost:${existingTerminal.port}`,
              terminalUrl: terminalProxyUrl,
            };
          }

          const terminal = await provider.startTerminal(params.id);

          // Build proxy URL
          const tunnelProvider =
            serviceRegistry.getProvider<TunnelProvider>("tunnel");
          const tunnelUrl =
            tunnelProvider && tunnelProvider.getActiveTunnelUrl
              ? await tunnelProvider.getActiveTunnelUrl()
              : null;
          const terminalProxyUrl = tunnelUrl
            ? `${tunnelUrl}/terminal/${encodeURIComponent(params.id)}/`
            : null;

          return {
            port: terminal.port,
            pid: terminal.pid,
            url: `http://localhost:${terminal.port}`,
            terminalUrl: terminalProxyUrl,
          };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to start terminal", details: String(err) };
        }
      })

      // Stop web terminal
      .post("/:id/terminal/stop", async ({ params, set }) => {
        const idError = validateSessionId(params.id);
        if (idError) {
          set.status = 400;
          return { error: idError };
        }
        try {
          const provider = await getProviderForSession(
            serviceRegistry,
            params.id,
          );
          const session = await provider.get(params.id);

          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          await provider.stopTerminal(params.id);
          return { success: true };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to stop terminal", details: String(err) };
        }
      })
  );
}
