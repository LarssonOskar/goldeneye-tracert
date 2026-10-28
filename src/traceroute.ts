import { isIP } from "node:net";

export interface HopReply {
  ip: string;
  rttMs: number | null;
}

export interface HopLine {
  ttl: number;
  ip: string | null;
  rttMs: number | null;
  timedOut: boolean;
  /** Every distinct responder seen in the hop block (ECMP paths). */
  replies?: HopReply[];
}

export interface TracerouteHeader {
  target: string;
  ip: string | null;
  maxHops: number | null;
}

const IP_TOKEN =
  /(?:\b\d{1,3}(?:\.\d{1,3}){3}\b|(?<![\w:])[0-9a-f]{0,4}:[0-9a-f:]{2,}(?![\w:]))/gi;
const RTT_TOKEN = /(\d+(?:\.\d+)?)\s*ms\b/gi;

function isIpToken(value: string): boolean {
  const version = isIP(value);
  return version === 4 || version === 6;
}

function collectIpTokens(text: string): Array<{ ip: string; index: number }> {
  const matches: Array<{ ip: string; index: number }> = [];
  for (const match of text.matchAll(IP_TOKEN)) {
    if (match.index === undefined || !isIpToken(match[0])) continue;
    matches.push({ ip: match[0], index: match.index });
  }
  return matches;
}

function collectRttTokens(text: string): Array<{ rttMs: number; index: number }> {
  const matches: Array<{ rttMs: number; index: number }> = [];
  for (const match of text.matchAll(RTT_TOKEN)) {
    const value = match[1];
    if (match.index === undefined || value === undefined) continue;
    matches.push({ rttMs: Number(value), index: match.index });
  }
  return matches;
}

/**
 * Parses a complete hop block. A block can span several physical lines on
 * macOS/Linux when traceroute reports multiple ECMP responders:
 *
 *   4  62.119.252.53 (...)  16.879 ms
 *      62.119.252.49 (...)  16.349 ms  16.995 ms
 *
 * The fastest responder becomes the primary IP/RTT; every distinct responder
 * is kept in `replies`.
 */
export function parseHopBlock(ttl: number, text: string): HopLine | null {
  const ipTokens = collectIpTokens(text);
  const rttTokens = collectRttTokens(text);

  const collected: HopReply[] = [];
  for (let index = 0; index < ipTokens.length; index += 1) {
    const token = ipTokens[index];
    if (!token) continue;
    const nextIpIndex = ipTokens[index + 1]?.index ?? Number.POSITIVE_INFINITY;
    const rtt = rttTokens.find((candidate) => candidate.index > token.index && candidate.index < nextIpIndex);
    collected.push({ ip: token.ip, rttMs: rtt?.rttMs ?? null });
  }

  // "192.168.10.1 (192.168.10.1)" contains the same IP twice. Keep one
  // reply and prefer the copy that actually has an RTT attached.
  const unique = new Map<string, HopReply>();
  const order: string[] = [];
  for (const reply of collected) {
    const existing = unique.get(reply.ip);
    if (!existing) {
      unique.set(reply.ip, reply);
      order.push(reply.ip);
    } else if (existing.rttMs === null && reply.rttMs !== null) {
      unique.set(reply.ip, reply);
    }
  }
  const replies = order.map((ip) => unique.get(ip)).filter((reply): reply is HopReply => Boolean(reply));

  if (replies.length === 0) {
    if (text.includes("*") || /timed out/i.test(text)) {
      return { ttl, ip: null, rttMs: null, timedOut: true, replies: [] };
    }
    return null;
  }

  // Windows prints RTTs before the IP: "8 ms 7 ms 9 ms  172.217.0.1".
  if (replies.every((reply) => reply.rttMs === null)) {
    const firstRtt = rttTokens[0];
    if (firstRtt) replies[0] = { ...replies[0]!, rttMs: firstRtt.rttMs };
  }

  const primary = replies.reduce<HopReply>((best, reply) => {
    if (reply.rttMs === null) return best;
    if (best.rttMs === null) return reply;
    return reply.rttMs < best.rttMs ? reply : best;
  }, replies[0]!);

  return {
    ttl,
    ip: primary.ip,
    rttMs: primary.rttMs,
    timedOut: false,
    replies,
  };
}

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

  return parseHopBlock(Number(ttlText), rest);
}
