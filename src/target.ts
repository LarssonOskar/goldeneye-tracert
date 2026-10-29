import { isIP } from "node:net";

/**
 * Accepts a hostname, IP, host:port or full URL and returns the traceroute
 * target host. This lets users paste `https://example.com/path` into a new
 * target prompt.
 */
export function normalizeTarget(input: string): string {
  const value = input.trim();
  if (!value) return "";

  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end > 1) return value.slice(1, end);
  }

  // Raw IPv6 literals contain several colons and have no scheme.
  if (!value.includes("://") && value.split(":").length > 2 && isIP(value) === 6) {
    return value;
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const host = new URL(candidate).hostname;
    if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
    return host;
  } catch {
    const withoutPath = value.split("/")[0] ?? value;
    return withoutPath.split(":")[0] ?? withoutPath;
  }
}
