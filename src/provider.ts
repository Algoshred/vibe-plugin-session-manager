/**
 * SessionProvider Interface
 *
 * Abstraction layer for terminal session management. Implementations can wrap
 * tmux, wezterm, screen, or any other terminal multiplexer.
 *
 * Default implementation: @vibecontrols/vibe-plugin-session-tmux
 */

import type {
  SessionConfig,
  SessionInfo,
  TerminalInfo,
  HealthCheckResult,
  SystemSessionInfo,
  SystemTerminalInfo,
} from "./types.js";

// ── Session Provider Capability Types ───────────────────────────────────

export interface SessionProviderCapabilities {
  /** Provider name (e.g., "tmux", "wezterm", "zellij") */
  provider: string;
  /** Supported features */
  features: {
    mouse: boolean;
    resize: boolean;
    capture: boolean;
    webTerminal: boolean;
    splitPanes: boolean;
    tabs: boolean;
    scrollback: boolean;
    clipboard: boolean;
    search: boolean;
  };
  /** Supported platforms */
  platform: string[];
}

export interface SessionProvider {
  /** Provider name (e.g., "tmux", "wezterm", "screen") */
  readonly name: string;

  /**
   * Create a new terminal session.
   */
  create(config: SessionConfig): Promise<SessionInfo>;

  /**
   * List all managed sessions.
   */
  list(): Promise<SessionInfo[]>;

  /**
   * Get a specific session by ID.
   */
  get(sessionId: string): Promise<SessionInfo | null>;

  /**
   * Kill/terminate a session.
   */
  kill(sessionId: string): Promise<void>;

  /**
   * Send a command to execute in the session (appends newline).
   */
  sendCommand(sessionId: string, command: string): Promise<void>;

  /**
   * Send raw keys to the session (e.g., "C-c" for interrupt, "Enter").
   */
  sendKeys(sessionId: string, keys: string): Promise<void>;

  /**
   * Send interrupt signal (Ctrl+C) to the session.
   */
  interrupt(sessionId: string): Promise<void>;

  /**
   * Capture the current visible output of the session.
   */
  capture(
    sessionId: string,
    options?: { lines?: number; pane?: string },
  ): Promise<string>;

  /**
   * Rename a session.
   */
  rename(sessionId: string, newName: string): Promise<void>;

  /**
   * Resize the session terminal.
   */
  resize(sessionId: string, cols: number, rows: number): Promise<void>;

  /**
   * Toggle mouse mode for the session.
   */
  toggleMouse(sessionId: string): Promise<void>;

  /**
   * Get termination status for a session (exited? exit code?).
   */
  getTerminationStatus(
    sessionId: string,
  ): Promise<{ exited: boolean; exitCode?: number }>;

  // ── Terminal Server Management ──────────────────────────────────────

  /**
   * Start a web terminal (ttyd) for the session.
   * Returns the terminal URL and process info.
   */
  startTerminal(sessionId: string): Promise<TerminalInfo>;

  /**
   * Stop the web terminal for a session.
   */
  stopTerminal(sessionId: string): Promise<void>;

  /**
   * Get the terminal URL for a session, if running.
   */
  getTerminalUrl(sessionId: string): Promise<string | null>;

  /**
   * Get terminal info for a session.
   */
  getTerminalInfo(sessionId: string): Promise<TerminalInfo | null>;

  // ── System-Level Operations ─────────────────────────────────────────

  /**
   * List all system sessions (including ones not managed by the agent).
   */
  listSystem(): Promise<SystemSessionInfo[]>;

  /**
   * List all running terminal server processes.
   */
  listSystemTerminals(): Promise<SystemTerminalInfo[]>;

  /**
   * Kill a system session (not necessarily managed by agent).
   */
  killSystem(sessionId: string): Promise<void>;

  /**
   * Kill a terminal server process by PID.
   */
  killSystemTerminal(pid: number): Promise<void>;

  /**
   * Health check for the session provider.
   */
  healthCheck(): Promise<HealthCheckResult>;

  // ── Extended Capability Methods ──────────────────────────────────────

  /**
   * Report provider capabilities for feature negotiation.
   * Optional — returns default capabilities if not implemented.
   */
  getCapabilities?(): SessionProviderCapabilities;

  /**
   * Get scrollback buffer content from the session.
   * Optional — not all providers support scrollback access.
   */
  getScrollback?(sessionId: string, lines: number): Promise<string>;

  /**
   * Search within session output for a pattern.
   * Optional — not all providers support output search.
   */
  searchOutput?(
    sessionId: string,
    pattern: string,
  ): Promise<{ line: number; content: string }[]>;
}
