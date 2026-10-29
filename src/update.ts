import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RELEASES_API = "https://api.github.com/repos/LarssonOskar/goldeneye-tracert/releases/latest";
const RELEASES_PAGE = "https://github.com/LarssonOskar/goldeneye-tracert/releases/latest";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 2000;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
}

interface UpdateCache {
  checkedAt: number;
  latest: string;
  url: string;
}

interface CheckForUpdateOptions {
  currentVersion: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  cachePath?: string;
  timeoutMs?: number;
}

export interface UpdateStep {
  command: string;
  args: string[];
}

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

/** Numeric semver comparison; build metadata and prerelease suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    normalizeVersion(value)
      .split(/[.+-]/)
      .map((part) => {
        const match = part.match(/^\d+/);
        return match ? Number(match[0]) : 0;
      });

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length, 3);
  for (let i = 0; i < length; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

export function defaultUpdateCachePath(): string {
  return join(homedir(), ".cache", "goldeneye-tracert", "update.json");
}

async function readCache(path: string): Promise<UpdateCache | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<UpdateCache>;
    if (
      typeof parsed.checkedAt !== "number" ||
      typeof parsed.latest !== "string" ||
      typeof parsed.url !== "string"
    ) {
      return null;
    }
    return { checkedAt: parsed.checkedAt, latest: parsed.latest, url: parsed.url };
  } catch {
    return null;
  }
}

async function writeCache(path: string, cache: UpdateCache): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(cache), "utf8");
  } catch {
    // A missing cache only means the next launch checks again.
  }
}

function infoFromCache(cache: UpdateCache, currentVersion: string): UpdateInfo | null {
  return isNewerVersion(cache.latest, currentVersion)
    ? { current: currentVersion, latest: normalizeVersion(cache.latest), url: cache.url }
    : null;
}

/**
 * Looks up the latest GitHub release at most once per day. Network and API
 * failures are intentionally silent: an update check must never block a trace.
 */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateInfo | null> {
  const now = options.now?.() ?? Date.now();
  const cachePath = options.cachePath ?? defaultUpdateCachePath();
  const cached = await readCache(cachePath);
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
    return infoFromCache(cached, options.currentVersion);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "goldeneye-tracert",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return cached ? infoFromCache(cached, options.currentVersion) : null;
    }

    const data = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
    const tag = typeof data.tag_name === "string" ? data.tag_name : "";
    if (!/^\d+(?:\.\d+)*$/.test(normalizeVersion(tag))) {
      return cached ? infoFromCache(cached, options.currentVersion) : null;
    }

    const latest = normalizeVersion(tag);
    const url = typeof data.html_url === "string" ? data.html_url : RELEASES_PAGE;
    await writeCache(cachePath, { checkedAt: now, latest, url });
    return isNewerVersion(latest, options.currentVersion)
      ? { current: options.currentVersion, latest, url }
      : null;
  } catch {
    return cached ? infoFromCache(cached, options.currentVersion) : null;
  }
}

export function updateSteps(): UpdateStep[] {
  return [
    { command: "brew", args: ["update"] },
    { command: "brew", args: ["upgrade", "goldeneye-tracert"] },
  ];
}

/** Runs Homebrew with the real terminal attached so progress is visible. */
export async function runBrewUpdate(
  options: { spawnImpl?: typeof spawn } = {},
): Promise<number> {
  const spawnImpl = options.spawnImpl ?? spawn;
  for (const step of updateSteps()) {
    const code = await new Promise<number>((resolve) => {
      const child = spawnImpl(step.command, step.args, { stdio: "inherit" });
      child.once("error", () => resolve(1));
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0) return code;
  }
  return 0;
}
