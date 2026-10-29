#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { demoMission } from "./demo.ts";
import { createGeoProvider, isPublicIp, type GeoProvider, type GeoResult } from "./geo-lookup.ts";
import { smoothCamera, WORLD_CAMERA, type MapCamera } from "./camera.ts";
import { stripTerminalSequences } from "./keys.ts";
import { pingOnce } from "./ping.ts";
import { normalizeTarget } from "./target.ts";
import { renderBoot } from "./render/boot.ts";
import { cameraForState, renderFrame, type SpikePing } from "./render/frame.ts";
import { createTraceRunner, type TraceProtocol, type TraceRunner } from "./runner.ts";
import { formatCoordinate } from "./geo.ts";
import type { HopLine } from "./traceroute.ts";
import { VERSION } from "./version.ts";
import {
  routeStations,
  targetReached,
  type LogKind,
  type MissionState,
  type NodeInfo,
  type ThemeName,
} from "./types.ts";

const BOOT_MS = 2100;
const FRAME_MS = 66;
const SPIKE_MS = 6200;
const THEMES: ThemeName[] = ["gold", "green", "ice"];

interface CliOutput {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  on?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
}

interface CliInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  setEncoding?(encoding: BufferEncoding): void;
  resume?(): void;
  pause?(): void;
  on?(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  removeListener?(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

export interface CliDeps {
  stdout: CliOutput;
  stderr: CliOutput;
  stdin: CliInput;
  env: NodeJS.ProcessEnv;
  now: () => number;
  runner: TraceRunner;
  geo: GeoProvider | null;
  width?: number;
  height?: number;
}

interface CliOptions {
  target: string | null;
  demo: boolean;
  maxHops: number;
  theme: ThemeName;
  protocol: TraceProtocol;
  once: boolean;
  json: boolean;
  color: boolean;
  geo: boolean;
  beep: boolean;
  help: boolean;
  version: boolean;
  width: number | undefined;
  height: number | undefined;
}

function defaults(): CliDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    now: Date.now,
    runner: createTraceRunner(),
    geo: createGeoProvider(),
  };
}

function parseCli(args: string[], deps: CliDeps): CliOptions {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      demo: { type: "boolean", short: "d" },
      "max-hops": { type: "string", short: "m" },
      theme: { type: "string", short: "t" },
      protocol: { type: "string" },
      once: { type: "boolean" },
      json: { type: "boolean" },
      "no-color": { type: "boolean" },
      "no-geo": { type: "boolean" },
      beep: { type: "boolean" },
      width: { type: "string" },
      height: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  const values = parsed.values;
  const maxHops = Number(values["max-hops"] ?? 30);
  const theme = (values.theme ?? "gold") as ThemeName;
  if (!THEMES.includes(theme)) {
    throw new Error(`Unknown theme "${theme}". Choose gold, green or ice.`);
  }
  if (!Number.isFinite(maxHops) || maxHops < 1 || maxHops > 64) {
    throw new Error("--max-hops must be between 1 and 64.");
  }

  const defaultProtocol: TraceProtocol = process.platform === "linux" ? "udp" : "icmp";
  const protocol = (values.protocol ?? defaultProtocol) as TraceProtocol;
  if (protocol !== "icmp" && protocol !== "udp") {
    throw new Error(`Unknown protocol "${protocol}". Choose icmp or udp.`);
  }

  const width = values.width === undefined ? deps.width : Number(values.width);
  const height = values.height === undefined ? deps.height : Number(values.height);
  if (width !== undefined && (!Number.isFinite(width) || width < 40)) {
    throw new Error("--width must be at least 40.");
  }
  if (height !== undefined && (!Number.isFinite(height) || height < 16)) {
    throw new Error("--height must be at least 16.");
  }

  const noColor = values["no-color"] ?? false;
  const color =
    !noColor &&
    deps.env.NO_COLOR === undefined &&
    ((deps.stdout.isTTY ?? false) || deps.env.FORCE_COLOR === "1");

  return {
    target: parsed.positionals[0] ?? null,
    demo: values.demo ?? false,
    maxHops: Math.floor(maxHops),
    theme,
    protocol,
    once: values.once ?? false,
    json: values.json ?? false,
    color,
    geo: !(values["no-geo"] ?? false),
    beep: values.beep ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
    width,
    height,
  };
}

function helpText(): string {
  return `GOLDENEYE TRACERT — orbital route telemetry for your terminal

Usage:
  goldeneye-tracert <host> [options]
  goldeneye-tracert --demo

Options:
  -d, --demo            simulate a round-the-world trace
  -m, --max-hops <n>    maximum hops (default 30)
  -t, --theme <name>    gold, green or ice (default gold)
      --protocol <name> icmp or udp (default: icmp on macOS/Windows, udp on Linux)
      --once            render one frame and exit
      --json            print the mission state as JSON
      --no-geo          skip geolocation lookups
      --no-color        disable ANSI colors
      --beep            beep when the target is locked
      --width <cols>    override terminal width (testing)
      --height <rows>   override terminal height (testing)
  -h, --help            show this help
  -v, --version         show version

Requires Node.js 22.18 or newer (TypeScript is stripped natively).
Press Q to quit, SPACE to pause, R to retrace, N (or /) for a new target, T to cycle the theme.`;
}

function missionTime(state: MissionState, now: number): number {
  return Math.max(0, now - state.startedAt);
}

function addLog(state: MissionState, kind: LogKind, text: string, now: number): void {
  state.logs.push({ at: missionTime(state, now), kind, text });
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
}

function createMission(target: string, now: number, demo: boolean): MissionState {
  return {
    target,
    targetIp: null,
    origin: null,
    hops: [],
    phase: "tracing",
    paused: false,
    startedAt: now,
    finishedAt: null,
    traceComplete: false,
    reveal: 0,
    activeHop: -1,
    logs: [
      { at: 0, kind: "sys", text: "ORBITAL ARRAY ONLINE // SAT-06" },
      { at: 0, kind: "sys", text: `TRACE INITIATED // ${target.toUpperCase()}` },
    ],
    demo,
    error: null,
  };
}

function nodeFromHop(hop: HopLine): NodeInfo {
  const alternates = (hop.replies ?? [])
    .filter((reply) => reply.ip !== hop.ip)
    .map((reply) => ({
      ip: reply.ip,
      rttMs: reply.rttMs,
      city: null,
      countryCode: null,
      lat: null,
      lon: null,
    }));

  return {
    ttl: hop.ttl,
    ip: hop.ip,
    rttMs: hop.rttMs,
    timedOut: hop.timedOut,
    local: hop.ip !== null && !isPublicIp(hop.ip),
    city: null,
    country: null,
    countryCode: null,
    org: null,
    asn: null,
    lat: null,
    lon: null,
    replyCount: Math.max(1, hop.replies?.length ?? 1),
    alternates,
  };
}

function nodeFromGeo(geo: GeoResult): NodeInfo {
  return {
    ttl: null,
    ip: geo.ip,
    rttMs: null,
    timedOut: false,
    local: false,
    city: geo.city,
    country: geo.country,
    countryCode: geo.countryCode,
    org: geo.org,
    asn: geo.asn,
    lat: geo.lat,
    lon: geo.lon,
  };
}

function addHop(state: MissionState, hop: NodeInfo, now: number): void {
  if (state.hops.some((candidate) => candidate.ttl === hop.ttl)) return;
  state.hops.push(hop);
  state.activeHop = state.hops.length - 1;
  const ttl = String(hop.ttl ?? 0).padStart(2, "0");
  if (hop.timedOut) {
    addLog(state, "warn", `HOP ${ttl}  NO RESPONSE`, now);
  } else if (hop.local) {
    addLog(state, "trace", `HOP ${ttl}  ${hop.ip ?? "--"}  LOCAL SEGMENT`, now);
  } else {
    const extraPaths = Math.max(0, (hop.replyCount ?? 1) - 1);
    addLog(
      state,
      "trace",
      `HOP ${ttl}  ${hop.ip ?? "--"}  ${hop.rttMs?.toFixed(1) ?? "--"} ms${
        extraPaths > 0 ? `  +${extraPaths} ECMP` : ""
      }`,
      now,
    );
  }
  if (hop.city) {
    addLog(
      state,
      "geo",
      `NODE ${ttl}  ${hop.city.toUpperCase()} ${hop.countryCode ?? ""}  ${
        typeof hop.lat === "number" && typeof hop.lon === "number"
          ? formatCoordinate({ lat: hop.lat, lon: hop.lon })
          : ""
      }`.trim(),
      now,
    );
  }
}

function applyGeo(state: MissionState, ip: string, geo: GeoResult, now: number): boolean {
  const hop = state.hops.find((candidate) => candidate.ip === ip);
  if (hop) {
    hop.city = geo.city;
    hop.country = geo.country;
    hop.countryCode = geo.countryCode;
    hop.org = geo.org;
    hop.asn = geo.asn;
    hop.lat = geo.lat;
    hop.lon = geo.lon;
    if (geo.city) {
      addLog(
        state,
        "geo",
        `GEO LOCK  ${geo.city.toUpperCase()} ${geo.countryCode ?? ""}  ${
          typeof geo.lat === "number" && typeof geo.lon === "number"
            ? formatCoordinate({ lat: geo.lat, lon: geo.lon })
            : "COORDINATES UNAVAILABLE"
        }`,
        now,
      );
    }
    return true;
  }

  for (const candidate of state.hops) {
    const alternate = candidate.alternates?.find((item) => item.ip === ip);
    if (!alternate) continue;
    alternate.city = geo.city;
    alternate.countryCode = geo.countryCode;
    alternate.lat = geo.lat;
    alternate.lon = geo.lon;
    return true;
  }
  return false;
}

async function runMissionOnce(
  target: string,
  options: CliOptions,
  deps: CliDeps,
): Promise<MissionState> {
  const now = deps.now();
  const state = createMission(target, now, false);
  addLog(state, "sys", `PROBE MODE // ${options.protocol.toUpperCase()}`, now);
  const geo = options.geo ? deps.geo : null;
  const originPromise = geo ? geo.locateSelf().catch(() => null) : Promise.resolve(null);

  const result = await deps.runner.run(target, {
    maxHops: options.maxHops,
    protocol: options.protocol,
    onHeader: (header) => {
      state.targetIp = header.ip;
    },
    onHop: (hop) => {
      addHop(state, nodeFromHop(hop), deps.now());
    },
  });

  state.traceComplete = true;
  state.finishedAt = deps.now();
  state.targetIp = result.header?.ip ?? state.targetIp;
  addLog(state, "sys", "TRACE COMPLETE", deps.now());

  const publicIps = state.hops
    .flatMap((hop) => [hop.ip, ...(hop.alternates?.map((alternate) => alternate.ip) ?? [])])
    .filter((ip): ip is string => ip !== null && isPublicIp(ip));
  if (geo && publicIps.length > 0) {
    const geoMap = await geo.lookup(publicIps);
    for (const [ip, geoResult] of geoMap) applyGeo(state, ip, geoResult, deps.now());
  }

  state.origin = await originPromise.then((geo) => (geo ? nodeFromGeo(geo) : null));
  if (state.origin?.city) {
    addLog(
      state,
      "geo",
      `ORIGIN  ${state.origin.city.toUpperCase()} ${state.origin.countryCode ?? ""}`,
      deps.now(),
    );
  }

  const stations = routeStations(state);
  state.reveal = Math.max(0, stations.length - 1);
  state.activeHop = state.hops.length - 1;
  state.finishedAt = state.finishedAt ?? deps.now();
  if (targetReached(state)) {
    state.phase = "locked";
    addLog(state, "ok", "TARGET LOCKED // ORBITAL SOLUTION CONVERGED", deps.now());
  } else {
    state.phase = "incomplete";
    addLog(state, "warn", "TRACE ENDED // TARGET NOT REACHED", deps.now());
  }
  return state;
}

interface Session {
  state: MissionState;
  abort: AbortController | null;
  demoIndex: number;
  demoTimer: ReturnType<typeof setInterval> | null;
  pendingGeo: Set<string>;
  geoBusy: boolean;
  lastGeoFlush: number;
  generation: number;
  camera: MapCamera;
  restart: () => void;
}

function createDemoState(now: number): MissionState {
  const template = demoMission();
  const state = createMission(template.target, now, true);
  state.targetIp = template.targetIp;
  state.origin = template.origin;
  state.logs = [
    { at: 0, kind: "sys", text: "ORBITAL ARRAY ONLINE // SAT-06" },
    { at: 0, kind: "sys", text: "DEMO UPLINK // SIMULATED ROUTE" },
  ];
  return state;
}

function startDemo(
  session: Session,
  now: () => number,
  onUpdate: () => void,
): void {
  const template = demoMission();
  const { state } = session;
  session.demoIndex = 0;
  if (session.demoTimer) clearInterval(session.demoTimer);
  session.demoTimer = setInterval(() => {
    if (state.paused) return;
    if (session.demoIndex >= template.hops.length) {
      if (session.demoTimer) clearInterval(session.demoTimer);
      session.demoTimer = null;
      state.traceComplete = true;
      state.finishedAt = now();
      addLog(state, "sys", "TRACE COMPLETE // SIMULATION", now());
      onUpdate();
      return;
    }
    const hop = template.hops[session.demoIndex];
    session.demoIndex += 1;
    if (hop) addHop(state, { ...hop }, now());
    onUpdate();
  }, 460);
}

function startReal(session: Session, target: string, options: CliOptions, deps: CliDeps): void {
  session.abort?.abort();
  const abort = new AbortController();
  session.abort = abort;
  session.generation += 1;
  const generation = session.generation;
  const { state } = session;
  const geo = options.geo ? deps.geo : null;
  addLog(state, "sys", `PROBE MODE // ${options.protocol.toUpperCase()}`, deps.now());

  if (geo) {
    void geo
      .locateSelf()
      .then((origin) => {
        if (generation !== session.generation || !origin) return;
        const next = nodeFromGeo(origin);
        if (state.origin) {
          next.city ??= state.origin.city;
          next.country ??= state.origin.country;
          next.countryCode ??= state.origin.countryCode;
          next.org ??= state.origin.org;
          next.asn ??= state.origin.asn;
          next.lat ??= state.origin.lat;
          next.lon ??= state.origin.lon;
        }
        state.origin = next;
        if (origin.city) {
          addLog(state, "geo", `ORIGIN  ${origin.city.toUpperCase()} ${origin.countryCode ?? ""}`, deps.now());
        }
      })
      .catch(() => {
        if (generation === session.generation) addLog(state, "warn", "ORIGIN LOOKUP FAILED", deps.now());
      });
  }

  void deps.runner
    .run(target, {
      maxHops: options.maxHops,
      protocol: options.protocol,
      signal: abort.signal,
      onHeader: (header) => {
        if (generation !== session.generation) return;
        state.targetIp = header.ip;
      },
      onHop: (hop) => {
        if (generation !== session.generation) return;
        const node = nodeFromHop(hop);
        addHop(state, node, deps.now());
        if (geo) {
          const ips = [node.ip, ...(node.alternates?.map((alternate) => alternate.ip) ?? [])];
          for (const ip of ips) {
            if (typeof ip === "string" && isPublicIp(ip)) session.pendingGeo.add(ip);
          }
        }
      },
    })
    .then(() => {
      if (generation !== session.generation) return;
      state.traceComplete = true;
      state.finishedAt = deps.now();
      addLog(state, "sys", "TRACE COMPLETE", deps.now());
    })
    .catch((error: unknown) => {
      if (generation !== session.generation || abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      state.phase = "error";
      state.error = message;
      addLog(state, "err", `LINK ERROR // ${message}`, deps.now());
    });
}

async function flushGeo(session: Session, options: CliOptions, deps: CliDeps): Promise<void> {
  const geo = options.geo ? deps.geo : null;
  if (!geo || session.geoBusy || session.pendingGeo.size === 0) return;
  session.geoBusy = true;
  const generation = session.generation;
  const ips = [...session.pendingGeo];
  session.pendingGeo.clear();
  try {
    const geoMap = await geo.lookup(ips);
    if (generation !== session.generation) return;
    for (const [ip, geoResult] of geoMap) applyGeo(session.state, ip, geoResult, deps.now());
  } catch {
    if (generation === session.generation) {
      addLog(session.state, "warn", "GEOLOCATION UPLINK UNAVAILABLE", deps.now());
    }
  } finally {
    session.geoBusy = false;
    session.lastGeoFlush = deps.now();
  }
}

function advance(
  session: Session,
  options: CliOptions,
  deps: CliDeps,
  dt: number,
  onLock: () => void,
): void {
  const { state } = session;
  const stations = routeStations(state);
  const end = Math.max(0, stations.length - 1);
  if (!state.paused && state.reveal < end) {
    state.reveal = Math.min(end, state.reveal + dt / 700);
  }
  const station = stations[Math.min(Math.floor(state.reveal), Math.max(0, stations.length - 1))];
  if (station) state.activeHop = station.hopIndex;

  const geoPending = options.geo && (session.pendingGeo.size > 0 || session.geoBusy);
  if (
    state.traceComplete &&
    !geoPending &&
    state.reveal >= end - 1e-6 &&
    state.phase === "tracing"
  ) {
    state.finishedAt = state.finishedAt ?? deps.now();
    if (targetReached(state)) {
      state.phase = "locked";
      addLog(state, "ok", "TARGET LOCKED // ORBITAL SOLUTION CONVERGED", deps.now());
      onLock();
    } else {
      state.phase = "incomplete";
      addLog(state, "warn", "TRACE ENDED // TARGET NOT REACHED", deps.now());
    }
  }
}

async function runInteractive(
  options: CliOptions,
  deps: CliDeps,
): Promise<number> {
  const initialWidth =
    options.width ??
    (typeof deps.stdout.columns === "number" && deps.stdout.columns > 0
      ? deps.stdout.columns
      : 120);
  const initialHeight =
    options.height ??
    (typeof deps.stdout.rows === "number" && deps.stdout.rows > 0 ? deps.stdout.rows : 40);
  let width = initialWidth;
  let height = initialHeight;
  let target = options.demo ? demoMission().target : options.target ?? "unknown";
  let demoMode = options.demo;
  let inputMode = false;
  let inputBuffer = "";
  let spike: { startedAt: number; target: string; ping: SpikePing | null } | null = null;
  let themeIndex = THEMES.indexOf(options.theme);
  let bootStart = deps.now();
  let lastFrame = bootStart;
  let finished = false;

  const state = demoMode ? createDemoState(bootStart) : createMission(target, bootStart, false);
  const session: Session = {
    state,
    abort: null,
    demoIndex: 0,
    demoTimer: null,
    pendingGeo: new Set(),
    geoBusy: false,
    lastGeoFlush: bootStart,
    generation: 0,
    camera: { ...WORLD_CAMERA },
    restart: () => undefined,
  };

  const write = (text: string): void => {
    deps.stdout.write(text);
  };

  const draw = (now: number): void => {
    const theme = THEMES[themeIndex] ?? "gold";
    const booting = now - bootStart < BOOT_MS;
    const lines = booting
      ? renderBoot({
          width,
          height,
          color: options.color,
          now,
          startedAt: bootStart,
          theme,
          target,
        })
      : renderFrame(session.state, {
          width,
          height,
          color: options.color,
          now,
          theme,
          camera: session.camera,
          ...(inputMode ? { prompt: { label: "NEW TARGET", value: inputBuffer } } : {}),
          ...(!inputMode && spike
            ? {
                spike: {
                  startedAt: spike.startedAt,
                  target: spike.target,
                  ping: spike.ping,
                },
              }
            : {}),
        });
    write(`\x1b[H${lines.join("\n")}`);
  };

  const cleanup = (): void => {
    clearInterval(loop);
    if (session.demoTimer) clearInterval(session.demoTimer);
    session.abort?.abort();
    deps.stdin.removeListener?.("data", onData);
    deps.stdout.removeListener?.("resize", onResize);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    deps.stdin.setRawMode?.(false);
    deps.stdin.pause?.();
    write("\x1b[?25h\x1b[?1049l");
  };

  let resolveExit: (code: number) => void = () => undefined;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    cleanup();
    resolveExit(code);
  };

  const beginTrace = (nextTarget: string, nextDemo: boolean): void => {
    const now = deps.now();
    const previousOrigin = session.state.origin;
    session.generation += 1;
    session.abort?.abort();
    session.abort = null;
    if (session.demoTimer) {
      clearInterval(session.demoTimer);
      session.demoTimer = null;
    }
    session.demoIndex = 0;
    session.pendingGeo.clear();
    session.geoBusy = false;
    demoMode = nextDemo;
    target = nextTarget;
    session.state = nextDemo ? createDemoState(now) : createMission(target, now, false);
    if (!nextDemo && previousOrigin) session.state.origin = previousOrigin;
    session.state.startedAt = now;
    session.camera = { ...WORLD_CAMERA };
    lastFrame = now;
    inputMode = false;
    inputBuffer = "";
    spike = null;
    if (nextDemo) startDemo(session, deps.now, () => undefined);
    else startReal(session, target, options, deps);
  };

  const sendSpike = (): void => {
    if (spike || session.state.phase !== "locked") return;
    const spikeTarget = target;
    const address = session.state.targetIp ?? target;
    addLog(session.state, "spike", "SPIKE SENT // COUNTER-TRACE BLOCKED", deps.now());
    spike = { startedAt: deps.now(), target: spikeTarget, ping: null };
    void pingOnce(address, 1500).then((result) => {
      if (!spike || spike.target !== spikeTarget) return;
      spike = {
        ...spike,
        ping: { ok: result.ok, rttMs: result.rttMs },
      };
    });
  };

  const restart = (): void => {
    beginTrace(demoMode ? demoMission().target : target, demoMode);
  };
  session.restart = restart;

  const onResize = (): void => {
    if (typeof deps.stdout.columns === "number" && deps.stdout.columns > 0) {
      width = deps.stdout.columns;
    }
    if (typeof deps.stdout.rows === "number" && deps.stdout.rows > 0) {
      height = deps.stdout.rows;
    }
  };

  const onData = (chunk: string | Buffer): void => {
    const text = stripTerminalSequences(chunk.toString());
    const now = deps.now();
    for (const key of text) {
      if (key === "\u0003") {
        finish(0);
        return;
      }
      if (inputMode) {
        if (key === "\u001b") {
          inputMode = false;
          inputBuffer = "";
        } else if (key === "\r" || key === "\n") {
          const next = normalizeTarget(inputBuffer);
          inputMode = false;
          inputBuffer = "";
          if (next) beginTrace(next, false);
        } else if (key === "\u007f" || key === "\b") {
          inputBuffer = inputBuffer.slice(0, -1);
        } else if ((key.codePointAt(0) ?? 0) >= 0x20 && inputBuffer.length < 200) {
          inputBuffer += key;
        }
        continue;
      }
      if (key === "q" || key === "Q") {
        finish(0);
        return;
      }
      if (key === "\u001b" && spike) {
        spike = null;
        continue;
      }
      if (now - bootStart < BOOT_MS) {
        bootStart = now - BOOT_MS;
        continue;
      }
      if (key === "n" || key === "N" || key === "/") {
        inputMode = true;
        inputBuffer = "";
      } else if (key === " ") {
        session.state.paused = !session.state.paused;
      } else if (key === "r" || key === "R") {
        restart();
      } else if (key === "s" || key === "S") {
        sendSpike();
      } else if (key === "t" || key === "T") {
        themeIndex = (themeIndex + 1) % THEMES.length;
      }
    }
  };

  const onSignal = (): void => finish(0);

  write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
  deps.stdin.setRawMode?.(true);
  deps.stdin.setEncoding?.("utf8");
  deps.stdin.resume?.();
  deps.stdin.on?.("data", onData);
  deps.stdout.on?.("resize", onResize);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const loop = setInterval(() => {
    const now = deps.now();
    const dt = Math.min(250, Math.max(0, now - lastFrame));
    lastFrame = now;

    if (now - bootStart >= BOOT_MS) {
      if (options.geo && (now - session.lastGeoFlush > 650 || session.state.traceComplete)) {
        void flushGeo(session, options, deps);
      }
      advance(session, options, deps, dt, () => {
        if (options.beep) write("\x07");
      });
      session.camera = smoothCamera(
        session.camera,
        cameraForState(session.state, width, height),
        dt,
      );
      if (spike && now - spike.startedAt > SPIKE_MS) spike = null;
    }
    draw(now);
  }, FRAME_MS);

  if (options.demo) startDemo(session, deps.now, () => undefined);
  else startReal(session, target, options, deps);

  return await exitPromise;
}

function formatJson(state: MissionState): string {
  return JSON.stringify(
    {
      version: VERSION,
      generatedAt: new Date().toISOString(),
      state,
    },
    null,
    2,
  );
}

function frameSize(options: CliOptions, deps: CliDeps): { width: number; height: number } {
  const columns = deps.stdout.columns;
  const rows = deps.stdout.rows;
  return {
    width:
      options.width ??
      (typeof columns === "number" && columns > 0 ? columns : 120),
    height:
      options.height ?? (typeof rows === "number" && rows > 0 ? rows : 40),
  };
}

export async function main(argv: string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...defaults(), ...overrides };
  let options: CliOptions;
  try {
    options = parseCli(argv, deps);
  } catch (error) {
    deps.stderr.write(`goldeneye: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (options.help) {
    deps.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (options.version) {
    deps.stdout.write(`goldeneye-tracert ${VERSION}\n`);
    return 0;
  }
  if (!options.demo && !options.target) {
    deps.stderr.write("goldeneye: missing target. Try --demo or --help.\n");
    return 1;
  }
  if (options.target && !options.demo) {
    const normalized = normalizeTarget(options.target);
    if (!normalized) {
      deps.stderr.write("goldeneye: target is empty.\n");
      return 1;
    }
    options.target = normalized;
  }

  const interactive =
    !options.once &&
    !options.json &&
    Boolean(deps.stdin.isTTY) &&
    Boolean(deps.stdout.isTTY) &&
    typeof deps.stdin.setRawMode === "function" &&
    typeof deps.stdin.on === "function";

  if (interactive) {
    return await runInteractive(options, deps);
  }

  if (options.json) {
    try {
      const state = options.demo ? demoMission() : await runMissionOnce(options.target ?? "", options, deps);
      deps.stdout.write(`${formatJson(state)}\n`);
      return 0;
    } catch (error) {
      deps.stderr.write(`goldeneye: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  let state: MissionState;
  if (options.demo) {
    state = demoMission();
  } else {
    try {
      state = await runMissionOnce(options.target ?? "", options, deps);
    } catch (error) {
      deps.stderr.write(`goldeneye: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const { width, height } = frameSize(options, deps);
  const lines = renderFrame(state, {
    width,
    height,
    color: options.color,
    now: deps.now(),
    theme: options.theme,
  });
  deps.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

const entry = (() => {
  if (!process.argv[1]) return "";
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return "";
  }
})();
if (entry !== "" && entry === fileURLToPath(import.meta.url)) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") process.exit(0);
      throw error;
    });
  }
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
