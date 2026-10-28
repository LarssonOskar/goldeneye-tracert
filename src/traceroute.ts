import { isIP } from "node:net";

export interface HopLine {
  ttl: number;
  ip: string | null;
  rttMs: number | null;
  timedOut: boolean;
}

export interface TracerouteHeader {
  target: string;
  ip: string | null;
  maxHops: number | null;
}

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
const IPV6 = /(?<![\w:])([0-9a-f]{0,4}:[0-9a-f:]{2,})(?![\w:])/i;
const RTT = /(\d+(?:\.\d+)?)\s*ms\b/i;

/**
 * Parses the header printed before the hop list on macOS, Linux and Windows.
 */
export function parseTracerouteHeader(line: string): TracerouteHeader | null {
  const unix = line.match(
    /^(?:traceroute6?|tracepath)\s+to\s+(\S+)\s+\(([^)]+)\).*?(\d+)\s+hops\s+max/i,
  );
  if (unix) {
    const [, target, ip, maxHops] = unix;
    if (!target || !ip || !maxHops) return null;
    return { target, ip, maxHops: Number(maxHops) };
  }

  const windows = line.match(
    /^Tracing route to (.+?)\s+\[([^\]]+)\]\s+over a maximum of\s+(\d+)\s+hops/i,
  );
  if (windows) {
    const [, target, ip, maxHops] = windows;
    if (!target || !ip || !maxHops) return null;
    return { target, ip, maxHops: Number(maxHops) };
  }

  return null;
}

/**
 * Parses one hop line from traceroute output.
 * Returns null for headers, blank lines and unparseable lines.
 */
export function parseHopLine(line: string): HopLine | null {
  const match = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!match) return null;

  const ttlText = match[1];
  const rest = match[2];
  if (ttlText === undefined || rest === undefined) return null;

  const ttl = Number(ttlText);
  const ipv4 = rest.match(IPV4)?.[1];
  const ipv6Match = rest.match(IPV6)?.[1];
  const ip = ipv4 ?? (ipv6Match && isIP(ipv6Match) === 6 ? ipv6Match : null);
  const rttText = rest.match(RTT)?.[1];
  const rttMs = rttText === undefined ? null : Number(rttText);

  if (ip === null) {
    if (rest.includes("*") || /timed out/i.test(rest)) {
      return { ttl, ip: null, rttMs: null, timedOut: true };
    }
    return null;
  }

  return { ttl, ip, rttMs, timedOut: false };
}
