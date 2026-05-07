/**
 * Lightweight request/url security helpers — locally redeclared.
 *
 * Mirrors a subset of `vibecontrols-agent`'s `core/request-security.ts` and
 * `core/url-security.ts`. The plugin can't depend on the agent at runtime,
 * so we re-implement just enough to keep the existing security posture.
 */

interface RequestIpServer {
  requestIP?(req: Request): { address?: string } | null;
}

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

function isLocalIpAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const cleaned = addr.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTS.has(cleaned)) return true;
  if (cleaned.startsWith("127.")) return true;
  return false;
}

export function isLikelyLocalRequest(
  request: Request,
  server?: RequestIpServer | null,
): boolean {
  try {
    const url = new URL(request.url);
    if (LOCAL_HOSTS.has(url.hostname)) return true;
  } catch {
    /* fall through */
  }
  try {
    const ip = server?.requestIP?.(request)?.address;
    if (isLocalIpAddress(ip)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function denyNonLocalMutation(
  request: Request,
  envOverride: string,
  server?: RequestIpServer | null,
): string | null {
  if (isLikelyLocalRequest(request, server)) return null;
  if (process.env[envOverride] === "1") return null;
  return `This operation is local-only by default. Set ${envOverride}=1 to allow it over a tunnel.`;
}

function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isAllowedCallbackUrl(
  rawUrl: string,
  trustedBaseUrls: Array<string | null | undefined>,
): boolean {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "https:" && !LOCAL_HOSTS.has(url.hostname)) {
      return false;
    }
    const host = normalizeHostname(url.hostname);
    for (const base of trustedBaseUrls) {
      if (!base) continue;
      try {
        const trusted = new URL(base);
        if (host === normalizeHostname(trusted.hostname)) return true;
      } catch {
        /* ignore malformed trusted bases */
      }
    }
    // Allow opt-in via env var for additional callback hosts.
    const extraAllow = process.env.VIBECONTROLS_ALLOWED_CALLBACK_HOSTS;
    if (extraAllow) {
      const hosts = extraAllow
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (hosts.includes(host)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
