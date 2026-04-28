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
}

export type SessionStatus = "active" | "inactive" | "terminated" | "error";

export interface TerminalInfo {
  url: string;
  port: number;
  pid: number;
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
