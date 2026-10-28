import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface GeoResult {
  ip: string;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  org: string | null;
  asn: string | null;
  lat: number | null;
  lon: number | null;
}

export interface GeoProvider {
  lookup(ips: readonly string[]): Promise<Map<string, GeoResult>>;
  locateSelf(): Promise<GeoResult | null>;
}

interface CacheEntry {
  fetchedAt: number;
  result: GeoResult;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

interface IpApiRow {
  status?: string;
  query?: string;
  country?: string;
  countryCode?: string;
  city?: string;
  lat?: number;
  lon?: number;
  isp?: string;
  org?: string;
  as?: string;
}

interface IpWhoRow {
  success?: boolean;
  ip?: string;
  country?: string;
  country_code?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  connection?: {
    asn?: number;
    org?: string;
    isp?: string;
  };
}

interface IfConfigRow {
  ip?: string;
  country?: string;
  country_iso?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  asn?: string;
  asn_org?: string;
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_SPACING_MS = 1100;
const FIELDS = "status,message,query,country,countryCode,city,lat,lon,isp,org,as";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function splitAs(value: unknown): { asn: string | null; org: string | null } {
  const text = asText(value);
  if (!text) return { asn: null, org: null };
  const match = text.match(/^(AS\d+)\s+(.*)$/i);
  if (match) {
    return { asn: match[1]?.toUpperCase() ?? null, org: match[2]?.trim() || null };
  }
  return { asn: text.toUpperCase(), org: null };
}

export function isPublicIp(ip: string): boolean {
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    return !(
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fe80:") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd")
    );
  }

  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;
  return true;
}

export class IpApiGeoProvider implements GeoProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly cacheDir: string;
  private readonly now: () => number;
  private cache: CacheFile | null = null;
  private lastRequestAt = 0;

  constructor(options: { cacheDir?: string; fetchImpl?: typeof fetch; now?: () => number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheDir =
      options.cacheDir ??
      join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "goldeneye-tracert");
    this.now = options.now ?? Date.now;
  }

  private get cachePath(): string {
    return join(this.cacheDir, "geo.json");
  }

  private async ensureCache(): Promise<CacheFile> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, "utf8")) as Partial<CacheFile>;
      this.cache = {
        version: 1,
        entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
      };
    } catch {
      this.cache = { version: 1, entries: {} };
    }
    return this.cache;
  }

  private async saveCache(): Promise<void> {
    if (!this.cache) return;
    const cutoff = this.now() - CACHE_TTL_MS;
    for (const [ip, entry] of Object.entries(this.cache.entries)) {
      if (entry.fetchedAt < cutoff) delete this.cache.entries[ip];
    }
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, JSON.stringify(this.cache), "utf8");
    } catch {
      // A read-only cache directory must not break a trace.
    }
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(6500),
      headers: {
        "User-Agent": "goldeneye-tracert/0.1",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return await response.json();
  }

  private async requestBatch(ips: readonly string[]): Promise<GeoResult[] | null> {
    const wait = Math.max(0, REQUEST_SPACING_MS - (this.now() - this.lastRequestAt));
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = this.now();

    try {
      const payload = await this.fetchJson(`http://ip-api.com/batch?fields=${FIELDS}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ips),
      });
      if (!Array.isArray(payload)) return null;

      const results: GeoResult[] = [];
      for (const raw of payload) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as IpApiRow;
        if (row.status !== "success" || typeof row.query !== "string") continue;
        const parsedAs = splitAs(row.as);
        results.push({
          ip: row.query,
          city: asText(row.city),
          country: asText(row.country),
          countryCode: asText(row.countryCode)?.toUpperCase() ?? null,
          org: asText(row.org) ?? asText(row.isp) ?? parsedAs.org,
          asn: parsedAs.asn,
          lat: asNumber(row.lat),
          lon: asNumber(row.lon),
        });
      }
      return results;
    } catch {
      return null;
    }
  }

  private async requestOne(ip: string): Promise<GeoResult | null> {
    try {
      const payload = (await this.fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}`)) as IpWhoRow;
      if (!payload || payload.success === false || typeof payload.ip !== "string") return null;
      const asn =
        typeof payload.connection?.asn === "number" ? `AS${payload.connection.asn}` : null;
      return {
        ip: payload.ip,
        city: asText(payload.city),
        country: asText(payload.country),
        countryCode: asText(payload.country_code)?.toUpperCase() ?? null,
        org: asText(payload.connection?.org) ?? asText(payload.connection?.isp),
        asn,
        lat: asNumber(payload.latitude),
        lon: asNumber(payload.longitude),
      };
    } catch {
      return null;
    }
  }

  async lookup(ips: readonly string[]): Promise<Map<string, GeoResult>> {
    const wanted = [...new Set(ips.filter(isPublicIp))];
    const result = new Map<string, GeoResult>();
    if (wanted.length === 0) return result;

    const cache = await this.ensureCache();
    const missing: string[] = [];
    for (const ip of wanted) {
      const entry = cache.entries[ip];
      if (entry && this.now() - entry.fetchedAt < CACHE_TTL_MS) {
        result.set(ip, entry.result);
      } else {
        missing.push(ip);
      }
    }

    let fresh = false;
    for (let offset = 0; offset < missing.length; offset += 100) {
      const chunk = missing.slice(offset, offset + 100);
      const batch = await this.requestBatch(chunk);
      if (batch) {
        for (const geo of batch) {
          result.set(geo.ip, geo);
          cache.entries[geo.ip] = { fetchedAt: this.now(), result: geo };
          fresh = true;
        }
        const unresolved = chunk.filter((ip) => !result.has(ip));
        if (unresolved.length > 0) {
          await this.fallbackLookup(unresolved, result, cache);
          fresh = true;
        }
      } else {
        await this.fallbackLookup(chunk, result, cache);
        fresh = true;
      }
    }

    if (fresh) await this.saveCache();
    return result;
  }

  private async fallbackLookup(
    ips: readonly string[],
    result: Map<string, GeoResult>,
    cache: CacheFile,
  ): Promise<void> {
    const concurrency = 4;
    for (let offset = 0; offset < ips.length; offset += concurrency) {
      const chunk = ips.slice(offset, offset + concurrency);
      const found = await Promise.all(chunk.map((ip) => this.requestOne(ip)));
      for (let i = 0; i < found.length; i += 1) {
        const geo = found[i];
        const ip = chunk[i];
        if (!geo || !ip) continue;
        result.set(ip, geo);
        cache.entries[ip] = { fetchedAt: this.now(), result: geo };
      }
    }
  }

  async locateSelf(): Promise<GeoResult | null> {
    try {
      const payload = (await this.fetchJson("https://ifconfig.co/json")) as IfConfigRow;
      if (typeof payload.ip === "string") {
        return {
          ip: payload.ip,
          city: asText(payload.city),
          country: asText(payload.country),
          countryCode: asText(payload.country_iso)?.toUpperCase() ?? null,
          org: asText(payload.asn_org),
          asn: asText(payload.asn)?.toUpperCase() ?? null,
          lat: asNumber(payload.latitude),
          lon: asNumber(payload.longitude),
        };
      }
    } catch {
      // Fall through to the simpler resolver below.
    }

    try {
      const payload = (await this.fetchJson("https://api.ipify.org?format=json")) as {
        ip?: string;
      };
      if (typeof payload.ip !== "string") return null;
      const found = await this.lookup([payload.ip]);
      return found.get(payload.ip) ?? null;
    } catch {
      return null;
    }
  }
}

export function createGeoProvider(): GeoProvider {
  return new IpApiGeoProvider();
}
