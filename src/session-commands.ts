import type { Command } from "commander";
import {
  type JsonRow,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  errMsg,
  fail,
  formatStatus,
  formatTable,
  getAgentUrl,
  header,
  info,
  kv,
  shortId,
  success,
} from "./utils/cli-helpers.js";
import {
  maybePrintJson,
  pickOutputMode,
  runMultimode,
} from "./utils/multimode.js";
import { interactiveTable, type TableRow } from "./utils/interactive.js";

const blank = () => console.log("");

const DEFAULT_AGENT_URL = "http://localhost:3005";

interface SessionShape {
  id?: string;
  name?: string;
  status?: string;
  port?: number | null;
  project?: string;
  projectId?: string;
}

function shapeSessions(sessions: SessionShape[]) {
  return (sessions || []).map((s) => ({
    id: s.id ?? null,
    name: s.name ?? null,
    status: s.status ?? null,
    port: s.port ?? null,
    project: s.project ?? s.projectId ?? null,
  }));
}

async function renderSessionList(
  url: string,
  endpoint: string,
  title: string,
  emptyMsg: string,
  merged: { json?: boolean; plain?: boolean },
): Promise<void> {
  await runMultimode({
    mode: pickOutputMode(merged),
    fetchData: async () => {
      const data = await apiGet<{ sessions: SessionShape[] }>(url, endpoint);
      return data.sessions || [];
    },
    plain: (sessions) => {
      if (!sessions || sessions.length === 0) {
        info(emptyMsg);
        return;
      }
      header(title);
      formatTable(
        sessions.map((s) => ({
          ID: shortId(s.id || ""),
          Name: s.name || "-",
          Status: formatStatus(s.status || ""),
          Port: s.port ?? "-",
          Project: s.project || s.projectId || "-",
        })),
      );
    },
    interactive: async (sessions) => {
      if (!sessions || sessions.length === 0) {
        header(title);
        info(emptyMsg);
        return;
      }
      const rows: TableRow[] = sessions.map((s) => ({
        id: String(s.id ?? ""),
        label: s.name || shortId(s.id || ""),
        hint: s.status || "",
        detail: [
          `ID:      ${s.id ?? "-"}`,
          `Name:    ${s.name ?? "-"}`,
          `Status:  ${formatStatus(s.status || "")}`,
          `Port:    ${s.port ?? "-"}`,
          `Project: ${s.project ?? s.projectId ?? "-"}`,
        ].join("\n"),
      }));
      await interactiveTable({
        title: `${title} — ${sessions.length} session(s)`,
        rows,
      });
    },
    json: (sessions) => shapeSessions(sessions),
  });
}

export function registerSessionCommands(
  programArg: unknown,
  _hostServices?: unknown,
): void {
  const program = programArg as Command;
  const cmd = program
    .command("session")
    .description("Manage terminal sessions");

  // session system
  cmd
    .command("system")
    .description("List system sessions (alias for `session list --system`)")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        await renderSessionList(
          url,
          "/api/sessions/system",
          "System Sessions",
          "No system sessions found.",
          merged,
        );
      } catch (err) {
        fail(errMsg(err));
      }
    });

  // session list
  cmd
    .command("list")
    .description("List all sessions")
    .option("--system", "Show system sessions instead of user sessions")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        const endpoint = options.system
          ? "/api/sessions/system"
          : "/api/sessions";
        await renderSessionList(
          url,
          endpoint,
          "Sessions",
          "No sessions found.",
          merged,
        );
      } catch (err) {
        fail(errMsg(err));
      }
    });

  // session create
  cmd
    .command("create")
    .description("Create a new session")
    .requiredOption("--name <name>", "Session name")
    .option("--project <id>", "Project ID", "default")
    .option("--command <cmd>", "Initial command to run")
    .option("--cwd <dir>", "Working directory")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        const body: Record<string, unknown> = {
          sessionName: options.name,
          projectId: options.project,
        };
        if (options.command) body.command = options.command;
        if (options.cwd) body.startDirectory = options.cwd;
        const result = await apiPost<JsonRow>(
          url,
          "/api/sessions/create",
          body,
        );
        const sessionId =
          result?.session?.id || result?.id || result?.sessionId;
        if (
          maybePrintJson(merged, {
            ok: true,
            id: sessionId,
            name: options.name,
            project: options.project,
          })
        )
          return;
        success(`Session created: ${shortId(sessionId)}`);
        kv("Name", options.name);
        kv("Project", options.project);
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // session kill
  cmd
    .command("kill")
    .description("Kill a session")
    .requiredOption("-i, --id <id>", "Session ID")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        await apiDelete<JsonRow>(url, `/api/sessions/${options.id}`);
        if (maybePrintJson(merged, { ok: true, id: options.id })) return;
        success(`Session ${shortId(options.id)} killed.`);
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // session exec
  cmd
    .command("exec")
    .description("Execute a command in a session")
    .requiredOption("-i, --id <id>", "Session ID")
    .requiredOption("-c, --command <cmd>", "Command to execute")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        const result = await apiPost<JsonRow>(
          url,
          `/api/sessions/${options.id}/command`,
          { command: options.command },
        );
        if (
          maybePrintJson(merged, {
            ok: true,
            id: options.id,
            output: result?.output ?? null,
          })
        )
          return;
        success("Command executed.");
        if (result?.output) {
          blank();
          console.log(result.output);
        }
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // session capture
  cmd
    .command("capture")
    .description("Capture session terminal output")
    .requiredOption("-i, --id <id>", "Session ID")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        await runMultimode({
          mode: pickOutputMode(merged),
          fetchData: () =>
            apiGet<JsonRow>(url, `/api/sessions/${options.id}/capture`),
          plain: (result) => {
            if (result?.content || result?.output) {
              console.log(result.content || result.output);
            } else {
              info("No capture data available.");
            }
          },
          json: (result) => ({
            id: options.id,
            content: result?.content ?? result?.output ?? null,
          }),
        });
      } catch (err) {
        fail(errMsg(err));
      }
    });

  // session keys
  cmd
    .command("keys")
    .description("Send keys to a session")
    .requiredOption("-i, --id <id>", "Session ID")
    .requiredOption("-k, --keys <keys>", "Keys to send")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        await apiPost<JsonRow>(url, `/api/sessions/${options.id}/keys`, {
          keys: options.keys,
        });
        if (maybePrintJson(merged, { ok: true, id: options.id })) return;
        success("Keys sent.");
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // session interrupt
  cmd
    .command("interrupt")
    .description("Send interrupt signal to a session")
    .requiredOption("-i, --id <id>", "Session ID")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        await apiPost<JsonRow>(
          url,
          `/api/sessions/${options.id}/interrupt`,
          {},
        );
        if (maybePrintJson(merged, { ok: true, id: options.id })) return;
        success(`Session ${shortId(options.id)} interrupted.`);
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // session rename
  cmd
    .command("rename")
    .description("Rename a session")
    .requiredOption("-i, --id <id>", "Session ID")
    .requiredOption("--name <name>", "New session name")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        await apiPut<JsonRow>(url, `/api/sessions/${options.id}/rename`, {
          newName: options.name,
        });
        if (
          maybePrintJson(merged, {
            ok: true,
            id: options.id,
            name: options.name,
          })
        )
          return;
        success(`Session ${shortId(options.id)} renamed to "${options.name}".`);
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // session toggle-mouse
  cmd
    .command("toggle-mouse")
    .description("Toggle mouse support in a session")
    .requiredOption("-i, --id <id>", "Session ID")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        const result = await apiPost<JsonRow>(
          url,
          `/api/sessions/${options.id}/toggle-mouse`,
          {},
        );
        if (
          maybePrintJson(merged, {
            ok: true,
            id: options.id,
            mouseEnabled: !!result?.mouseEnabled,
          })
        )
          return;
        success(
          `Mouse support ${result?.mouseEnabled ? "enabled" : "toggled"} for session ${shortId(options.id)}.`,
        );
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // session terminal-start
  cmd
    .command("terminal-start")
    .description("Start terminal for a session")
    .requiredOption("-i, --id <id>", "Session ID")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        const result = await apiPost<JsonRow>(
          url,
          `/api/sessions/${options.id}/terminal`,
          {},
        );
        if (
          maybePrintJson(merged, {
            ok: true,
            id: options.id,
            port: result?.port ?? null,
          })
        )
          return;
        success(`Terminal started for session ${shortId(options.id)}.`);
        if (result?.port) kv("Port", result.port);
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // session terminal-stop
  cmd
    .command("terminal-stop")
    .description("Stop terminal for a session")
    .requiredOption("-i, --id <id>", "Session ID")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        await apiPost<JsonRow>(
          url,
          `/api/sessions/${options.id}/terminal/stop`,
          {},
        );
        if (maybePrintJson(merged, { ok: true, id: options.id })) return;
        success(`Terminal stopped for session ${shortId(options.id)}.`);
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // session health-check
  cmd
    .command("health-check")
    .description("Run health check on all sessions")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        const list = await apiGet<{ sessions: JsonRow[] }>(
          url,
          "/api/sessions",
        );
        const result = await apiPost<JsonRow>(
          url,
          "/api/sessions/health-check",
          {
            sessionIds: (list.sessions || []).map((session) => session.id),
          },
        );
        if (
          maybePrintJson(merged, {
            ok: true,
            healthy: result?.healthy ?? null,
            checked: result?.checked ?? null,
            fixed: result?.fixed ?? null,
          })
        )
          return;
        success("Health check completed.");
        if (result?.healthy !== undefined) kv("Healthy", result.healthy);
        if (result?.checked !== undefined) kv("Checked", result.checked);
        if (result?.fixed !== undefined) kv("Fixed", result.fixed);
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });
}
