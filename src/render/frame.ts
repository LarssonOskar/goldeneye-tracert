import {
  formatCoordinate,
  interpolateGreatCircle,
  routeDistanceKm,
  sampleGreatCircle,
  type GeoPoint,
} from "../geo.ts";
import { getLandMask, LAND_HEIGHT, LAND_WIDTH } from "../land.ts";
import { createProjection, type GeoBounds, type GeoProjection } from "../map.ts";
import { themeByName, type StyleRole } from "../theme.ts";
import { VERSION } from "../version.ts";
import {
  cityCode,
  routeStations,
  type LogKind,
  type LogLine,
  type MissionPhase,
  type MissionState,
  type NodeInfo,
  type RouteStation,
  type ThemeName,
} from "../types.ts";
import { BrailleCanvas } from "./braille.ts";
import { Screen, truncate } from "./screen.ts";

export interface FrameOptions {
  width: number;
  height: number;
  color?: boolean;
  now?: number;
  theme?: ThemeName;
  labels?: boolean;
  grid?: boolean;
}

const MAP_BOUNDS: GeoBounds = { west: -180, east: 180, south: -60, north: 84 };
const MAP_LAT_SPAN = MAP_BOUNDS.north - MAP_BOUNDS.south;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pad2(value: number): string {
  return String(Math.floor(value)).padStart(2, "0");
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${pad2(minutes)}:${pad2(seconds)}.${tenths}`;
}

function formatKm(km: number): string {
  return `${Math.round(km).toLocaleString("en-US")} KM`;
}

function formatRtt(rtt: number | null): string {
  if (rtt === null) return "LOSS";
  return `${rtt.toFixed(1)}ms`;
}

function formatShortRtt(rtt: number | null): string {
  if (rtt === null) return "LOSS";
  return rtt.toFixed(1);
}

function logRole(kind: LogKind): StyleRole {
  switch (kind) {
    case "warn":
      return "warn";
    case "err":
      return "error";
    case "ok":
      return "hot";
    case "geo":
      return "mid";
    case "trace":
      return "dim";
    case "sys":
      return "dim";
    default:
      return "dim";
  }
}

function activeStationIndex(stations: readonly RouteStation[], reveal: number): number {
  if (stations.length === 0) return 0;
  return clamp(Math.floor(reveal), 0, stations.length - 1);
}

function activePoint(stations: readonly RouteStation[], reveal: number): GeoPoint | null {
  if (stations.length === 0) return null;
  const index = activeStationIndex(stations, reveal);
  const current = stations[index]?.node;
  if (!current) return null;
  const fraction = clamp(reveal - index, 0, 1);
  const next = stations[index + 1]?.node;
  if (fraction <= 0 || !next) {
    if (typeof current.lat === "number" && typeof current.lon === "number") {
      return { lat: current.lat, lon: current.lon };
    }
    return null;
  }
  if (
    typeof current.lat !== "number" ||
    typeof current.lon !== "number" ||
    typeof next.lat !== "number" ||
    typeof next.lon !== "number"
  ) {
    return null;
  }
  return interpolateGreatCircle(
    { lat: current.lat, lon: current.lon },
    { lat: next.lat, lon: next.lon },
    fraction,
  );
}

function noise(x: number, y: number): number {
  let value = Math.imul(x + 13, 374_761_393) + Math.imul(y + 71, 668_265_263);
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177);
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295;
}

function isGridLine(lat: number, lon: number): boolean {
  const latMod = ((lat % 30) + 30) % 30;
  const lonMod = ((lon % 30) + 30) % 30;
  const latDistance = Math.min(latMod, 30 - latMod);
  const lonDistance = Math.min(lonMod, 30 - lonMod);
  return latDistance < 0.85 || lonDistance < 0.95;
}

function isPrimeLine(lat: number, lon: number): boolean {
  return Math.abs(lat) < 0.8 || Math.abs(lon) < 0.8;
}

function drawTerrain(canvas: BrailleCanvas, bounds: GeoBounds, grid: boolean): void {
  const mask = getLandMask();
  for (let y = 0; y < canvas.dotHeight; y += 1) {
    const lat = bounds.north - ((y + 0.5) / canvas.dotHeight) * MAP_LAT_SPAN;
    for (let x = 0; x < canvas.dotWidth; x += 1) {
      const lon = bounds.west + ((x + 0.5) / canvas.dotWidth) * 360;
      const maskX = clamp(Math.floor(((lon + 180) / 360) * LAND_WIDTH), 0, LAND_WIDTH - 1);
      const maskY = clamp(Math.floor(((90 - lat) / 180) * LAND_HEIGHT), 0, LAND_HEIGHT - 1);

      if (mask[maskY * LAND_WIDTH + maskX] === 1) {
        let coastal = false;
        for (let dy = -2; dy <= 2 && !coastal; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const nx = maskX + dx;
            const ny = maskY + dy;
            if (nx < 0 || ny < 0 || nx >= LAND_WIDTH || ny >= LAND_HEIGHT) continue;
            if (mask[ny * LAND_WIDTH + nx] !== 1) {
              coastal = true;
              break;
            }
          }
        }

        if (coastal) {
          canvas.plot(x, y, 2);
        } else if (noise(x, y) < 0.08) {
          canvas.plot(x, y, 1);
        }
      } else if (grid && isGridLine(lat, lon) && (x + y) % 6 === 0) {
        canvas.plot(x, y, isPrimeLine(lat, lon) ? 1 : 0);
      }
    }
  }
}

function projectPoint(projection: GeoProjection, point: GeoPoint): { x: number; y: number } {
  return projection.project(point);
}

function drawSegment(
  canvas: BrailleCanvas,
  projection: GeoProjection,
  from: NodeInfo,
  to: NodeInfo,
  progress: number,
): void {
  if (
    typeof from.lat !== "number" ||
    typeof from.lon !== "number" ||
    typeof to.lat !== "number" ||
    typeof to.lon !== "number"
  ) {
    return;
  }

  const steps = 128;
  const samples = sampleGreatCircle(
    { lat: from.lat, lon: from.lon },
    { lat: to.lat, lon: to.lon },
    steps,
  );
  const limit = Math.max(2, Math.min(steps, Math.ceil((steps - 1) * clamp(progress, 0, 1)) + 1));

  let previousSample: GeoPoint | null = null;
  let previousPoint: { x: number; y: number } | null = null;

  for (let i = 0; i < limit; i += 1) {
    const sample = samples[i];
    if (!sample) continue;
    if (previousSample && Math.abs(sample.lon - previousSample.lon) > 180) {
      previousPoint = null;
    }

    const point = projectPoint(projection, sample);
    if (previousPoint) {
      canvas.line(previousPoint.x * 2, previousPoint.y * 4, point.x * 2, point.y * 4, 3);
    }
    canvas.plot(Math.round(point.x * 2), Math.round(point.y * 4), 3);

    previousSample = sample;
    previousPoint = point;
  }
}

function drawRoute(
  canvas: BrailleCanvas,
  projection: GeoProjection,
  stations: readonly RouteStation[],
  reveal: number,
  now: number,
): void {
  if (stations.length < 2) return;
  const index = activeStationIndex(stations, reveal);
  const fraction = clamp(reveal - index, 0, 1);

  for (let i = 1; i <= index; i += 1) {
    const from = stations[i - 1]?.node;
    const to = stations[i]?.node;
    if (from && to) drawSegment(canvas, projection, from, to, 1);
  }

  if (fraction > 0 && index + 1 < stations.length) {
    const from = stations[index]?.node;
    const to = stations[index + 1]?.node;
    if (from && to) drawSegment(canvas, projection, from, to, fraction);
  }

  const point = activePoint(stations, reveal);
  if (!point) return;
  const projected = projection.project(point);
  const dotX = projected.x * 2;
  const dotY = projected.y * 4;
  const phase = (now % 1600) / 1600;
  canvas.circle(dotX, dotY, 3 + phase * 9, 2, true);
  canvas.circle(dotX, dotY, 2, 3, true);
}

interface MapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function drawMapLabels(
  screen: Screen,
  rect: MapRect,
  projection: GeoProjection,
  stations: readonly RouteStation[],
  reveal: number,
  active: GeoPoint | null,
  phase: MissionPhase,
  now: number,
): void {
  if (rect.w < 70) return;

  for (const lon of [-120, -60, 0, 60, 120]) {
    const point = projection.project({ lat: 0, lon });
    const label = lon === 0 ? "0°" : `${Math.abs(lon)}${lon < 0 ? "W" : "E"}`;
    const x = rect.x + Math.round(point.x) - Math.floor(label.length / 2);
    screen.put(x, rect.y + rect.h - 1, label, "grid");
  }

  for (const lat of [60, 30, 0, -30]) {
    const point = projection.project({ lat, lon: -180 });
    const label = lat === 0 ? "0°" : `${Math.abs(lat)}${lat > 0 ? "N" : "S"}`;
    screen.put(rect.x, rect.y + Math.round(point.y), label, "grid");
  }

  const occupied = new Set<string>();
  const labelAnchors: Array<[number, number, number]> = [];
  const seenCities = new Set<string>();
  if (active) {
    const activePoint = projection.project(active);
    const activeX = rect.x + Math.round(activePoint.x);
    const activeY = rect.y + Math.round(activePoint.y);
    for (let y = activeY - 1; y <= activeY + 1; y += 1) {
      for (let x = activeX - 3; x <= activeX + 3; x += 1) occupied.add(key(x, y));
    }
  }

  for (let i = 0; i <= Math.min(activeStationIndex(stations, reveal), stations.length - 1); i += 1) {
    const station = stations[i];
    if (!station) continue;
    const node = station.node;
    if (typeof node.lat !== "number" || typeof node.lon !== "number") continue;
    const point = projection.project({ lat: node.lat, lon: node.lon });
    const x = rect.x + Math.round(point.x);
    const y = rect.y + Math.round(point.y);
    occupied.add(key(x, y));
  }

  for (let i = 0; i < stations.length; i += 1) {
    const station = stations[i];
    if (!station) continue;
    const node = station.node;
    if (typeof node.lat !== "number" || typeof node.lon !== "number") continue;
    if (i > activeStationIndex(stations, reveal)) continue;
    const code = cityCode(node.city);
    if (code.trim() === "---") continue;
    const cityKey = (node.city ?? "").trim().toLowerCase();
    if (cityKey && seenCities.has(cityKey)) continue;
    const point = projection.project({ lat: node.lat, lon: node.lon });
    const markerX = rect.x + Math.round(point.x);
    const markerY = rect.y + Math.round(point.y);
    const candidates: Array<[number, number]> = [
      [markerX + 2, markerY],
      [markerX + 2, markerY - 1],
      [markerX - code.length - 1, markerY],
      [markerX - code.length - 1, markerY - 1],
      [markerX + 2, markerY + 1],
      [markerX - code.length - 1, markerY + 1],
      [markerX + 4, markerY],
      [markerX - code.length - 3, markerY],
    ];

    for (const [x, y] of candidates) {
      if (x < rect.x || y < rect.y || x + code.length > rect.x + rect.w || y >= rect.y + rect.h) {
        continue;
      }
      let free = true;
      for (let offset = 0; offset < code.length; offset += 1) {
        if (occupied.has(key(x + offset, y))) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      const tooClose = labelAnchors.some(
        ([anchorX, anchorY, anchorLength]) =>
          Math.abs(y - anchorY) <= 1 &&
          x < anchorX + anchorLength + 2 &&
          x + code.length + 2 > anchorX,
      );
      if (tooClose) continue;

      const role: StyleRole =
        i === stations.length - 1
          ? phase === "locked"
            ? "hot"
            : phase === "incomplete"
              ? "warn"
              : "bright"
          : i === 0
            ? "accent"
            : i === activeStationIndex(stations, reveal)
              ? "bright"
              : "dim";
      screen.put(x, y, code, role);
      labelAnchors.push([x, y, code.length]);
      if (cityKey) seenCities.add(cityKey);
      for (let offset = 0; offset < code.length; offset += 1) occupied.add(key(x + offset, y));
      break;
    }
  }

  if (!active) return;
  const point = projection.project(active);
  const cx = rect.x + Math.round(point.x);
  const cy = rect.y + Math.round(point.y);
  const pulse = Math.sin(now / 260) > 0.25 ? 1 : 0;
  const radius = 2 + pulse;
  const reticleRole: StyleRole = phase === "incomplete" ? "warn" : "hot";
  const corners: Array<[number, number, string]> = [
    [cx - radius, cy - 1, "┌"],
    [cx + radius, cy - 1, "┐"],
    [cx - radius, cy + 1, "└"],
    [cx + radius, cy + 1, "┘"],
  ];
  for (const [x, y, ch] of corners) {
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) {
      screen.put(x, y, ch, reticleRole);
    }
  }
  screen.put(cx, cy, "◉", reticleRole);
}

function drawHeader(screen: Screen, state: MissionState, now: number): void {
  const width = screen.width;
  const stations = routeStations(state);
  const elapsed = Math.max(0, (state.finishedAt ?? now) - state.startedAt);
  const loss = state.hops.length
    ? (state.hops.filter((hop) => hop.timedOut).length / state.hops.length) * 100
    : 0;
  const distance = routeDistanceKm(stations.map((station) => station.node).filter((node) => typeof node.lat === "number" && typeof node.lon === "number") as GeoPoint[]);

  screen.put(2, 1, "◤", "bright");
  screen.put(4, 1, "GOLDENEYE", "hot");
  screen.put(13, 1, "◢", "bright");
  if (width >= 74) {
    screen.put(16, 1, "//  SATELLITE UPLINK", "dim");
  }
  if (width >= 100) {
    screen.put(39, 1, "MISSION 001", "grid");
  }

  const status =
    state.phase === "error"
      ? "[ × LINK LOST ]"
      : state.phase === "incomplete"
        ? "[ ○ NO TARGET LOCK ]"
        : state.paused
          ? "[ ‖ TRACE PAUSED ]"
          : state.phase === "locked"
            ? "[ ● TARGET LOCKED ]"
            : "[ ● UPLINK ACTIVE ]";
  const statusRole: StyleRole =
    state.phase === "error"
      ? "error"
      : state.phase === "incomplete"
        ? "warn"
        : state.paused
          ? "warn"
          : state.phase === "locked"
            ? "hot"
            : "bright";
  screen.putRight(width - 3, 1, status, statusRole);

  let x = 2;
  screen.put(x, 2, "TARGET", "dim");
  x += 7;
  const targetText = truncate(state.target, Math.max(12, Math.floor(width * 0.32)));
  screen.put(x, 2, targetText, "bright");
  x += targetText.length;
  if (state.targetIp && x + state.targetIp.length + 3 < width - 16) {
    screen.put(x + 2, 2, `[${state.targetIp}]`, "dim");
  }

  const stats = [
    `HOPS ${String(state.hops.length).padStart(2, "0")}`,
    `T+ ${formatElapsed(elapsed)}`,
    `LOSS ${String(Math.round(loss)).padStart(2, "0")}%`,
    `ROUTE ${formatKm(distance)}`,
  ];
  let statText = stats.join("   ");
  while (statText.length > width - x - 8 && stats.length > 1) {
    stats.pop();
    statText = stats.join("   ");
  }
  if (statText.length > 0) screen.putRight(width - 3, 2, statText, "mid");
}

function drawRule(
  screen: Screen,
  y: number,
  left: string,
  right: string | null,
  rightRole: StyleRole = "dim",
): void {
  screen.hline(1, y, screen.width - 2, "─", "frame");
  screen.put(2, y, ` ${left} `, "mid");
  if (right) {
    const available = screen.width - 6 - left.length;
    if (available > 10) {
      screen.putRight(screen.width - 3, y, ` ${truncate(right, available - 2)} `, rightRole);
    }
  }
}

function drawBar(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  percent: number,
  filled: StyleRole,
  empty: StyleRole,
): void {
  const clamped = clamp(percent, 0, 100);
  const filledWidth = Math.round((clamped / 100) * width);
  screen.put(x, y, "█".repeat(filledWidth), filled);
  screen.put(x + filledWidth, y, "░".repeat(Math.max(0, width - filledWidth)), empty);
}

interface LinkStats {
  loss: number;
  quality: number;
  jitter: number;
  mean: number;
}

function linkStats(state: MissionState): LinkStats {
  const loss = state.hops.length
    ? state.hops.filter((hop) => hop.timedOut).length / state.hops.length
    : 0;
  const rtts = state.hops
    .map((hop) => hop.rttMs)
    .filter((rtt): rtt is number => typeof rtt === "number");
  const mean = rtts.length ? rtts.reduce((sum, rtt) => sum + rtt, 0) / rtts.length : 0;
  const variance = rtts.length
    ? rtts.reduce((sum, rtt) => sum + (rtt - mean) ** 2, 0) / rtts.length
    : 0;
  const jitter = Math.sqrt(variance);
  const quality = Math.round(
    clamp(100 - loss * 120 - Math.min(22, (jitter / Math.max(1, mean)) * 18), 5, 100),
  );
  return { loss, quality, jitter, mean };
}

function nodeLine(node: NodeInfo | null): { city: string; code: string; org: string; coords: string } {
  if (!node) return { city: "--", code: "--", org: "--", coords: "--" };
  const city = node.city ? `${node.city}${node.countryCode ? `, ${node.countryCode}` : ""}` : "--";
  const org = node.org ?? node.asn ?? node.country ?? "--";
  const coords =
    typeof node.lat === "number" && typeof node.lon === "number"
      ? formatCoordinate({ lat: node.lat, lon: node.lon })
      : node.local
        ? "LOCAL SEGMENT"
        : "--";
  return { city, code: cityCode(node.city), org, coords };
}

function drawLogs(
  screen: Screen,
  logs: readonly LogLine[],
  x: number,
  y: number,
  width: number,
  rows: number,
): void {
  const visible = logs.slice(-rows);
  for (let i = 0; i < visible.length; i += 1) {
    const log = visible[i];
    if (!log) continue;
    const row = y + i;
    const time = `${pad2(Math.floor(log.at / 60_000))}:${pad2(Math.floor((log.at % 60_000) / 1000))}`;
    screen.put(x, row, `${time} `, "grid");
    screen.put(x + 6, row, truncate(log.text, Math.max(0, width - 7)), logRole(log.kind));
  }
}

function drawDashboard(
  screen: Screen,
  state: MissionState,
  stations: readonly RouteStation[],
  dashTop: number,
  compact: boolean,
): void {
  const width = screen.width;
  const bottom = screen.height - 4;
  const stats = linkStats(state);
  const activeIndex = activeStationIndex(stations, state.reveal);
  const activeNode = stations[activeIndex]?.node ?? state.hops.at(-1) ?? state.origin;
  const active = nodeLine(activeNode);
  const origin = nodeLine(state.origin);
  const lock = stations.length > 1 ? (state.reveal / (stations.length - 1)) * 100 : 100;
  const latestLog = state.logs.at(-1);

  if (compact) {
    drawRule(screen, dashTop, "TELEMETRY", state.phase === "locked" ? "TARGET LOCKED" : state.phase === "incomplete" ? "NO LOCK" : "LIVE", state.phase === "locked" ? "hot" : state.phase === "incomplete" ? "warn" : "dim");
    const originText = origin.city === "--" ? "UNKNOWN" : origin.city;
    screen.put(2, dashTop + 1, "ORIGIN", "dim");
    screen.put(9, dashTop + 1, truncate(originText, 20), "mid");
    screen.put(31, dashTop + 1, "→", "grid");
    screen.put(33, dashTop + 1, "ACTIVE", "dim");
    screen.put(41, dashTop + 1, truncate(active.city, Math.max(8, width - 44)), "bright");

    screen.put(2, dashTop + 2, "LINK", "dim");
    drawBar(screen, 7, dashTop + 2, 10, stats.quality, "bright", "grid");
    screen.put(19, dashTop + 2, `${String(Math.round(stats.quality)).padStart(3)}%`, "bright");
    screen.put(25, dashTop + 2, `LOSS ${String(Math.round(stats.loss * 100)).padStart(2, "0")}%`, stats.loss > 0 ? "warn" : "dim");
    if (width >= 70) {
      screen.put(38, dashTop + 2, `ROUTE ${formatKm(routeDistanceKm(stations.map((station) => station.node).filter((node) => typeof node.lat === "number" && typeof node.lon === "number") as GeoPoint[]))}`, "dim");
    }

    screen.put(2, dashTop + 3, "›", "bright");
    screen.put(4, dashTop + 3, truncate(latestLog?.text ?? "AWAITING TELEMETRY", width - 6), latestLog ? logRole(latestLog.kind) : "dim");

    screen.put(2, dashTop + 4, "LOCK", "dim");
    drawBar(screen, 7, dashTop + 4, 12, lock, "bright", "grid");
    screen.put(21, dashTop + 4, `${String(Math.round(lock)).padStart(3)}%`, "bright");
    screen.put(27, dashTop + 4, `HOPS ${String(state.hops.length).padStart(2, "0")}`, "dim");
    return;
  }

  const leftX = 2;
  const leftW = Math.max(34, Math.round((width - 4) * 0.44));
  const dividerX = leftX + leftW;
  const rightX = dividerX + 2;
  const rightW = Math.max(24, width - 2 - rightX + 1);
  const progressY = bottom;

  screen.hline(1, dashTop, width - 2, "─", "frame");
  screen.put(leftX, dashTop, " SIGNAL ANALYSIS ", "mid");
  screen.put(rightX, dashTop, " ROUTE MANIFEST ", "mid");
  screen.putRight(width - 3, dashTop, ` ${String(state.hops.length).padStart(2, "0")} NODES `, "dim");
  screen.vline(dividerX, dashTop + 1, Math.max(0, bottom - dashTop), "│", "frame");

  const colA = leftX;
  const colAW = Math.max(14, Math.round(leftW * 0.5) - 1);
  const colB = colA + colAW + 2;
  const colBW = Math.max(10, leftX + leftW - colB);
  const row = dashTop + 1;

  screen.put(colA, row, "ORIGIN", "dim");
  screen.put(colB, row, "ACTIVE NODE", "dim");
  if (bottom > row + 1) {
    screen.put(colA, row + 1, truncate(origin.city, colAW), "mid");
    const rttText = formatRtt(activeNode?.rttMs ?? null);
    const cityWidth = colBW > 17 ? colBW - rttText.length - 2 : colBW;
    screen.put(colB, row + 1, truncate(active.city, cityWidth), "hot");
    if (colBW > 17) screen.put(colB + colBW - rttText.length, row + 1, rttText, "accent");
  }
  if (bottom > row + 2) {
    screen.put(colA, row + 2, truncate(origin.org, colAW), "dim");
    const ip = activeNode?.ip ? `${activeNode.ip}` : "--";
    screen.put(colB, row + 2, truncate(ip, colBW), "bright");
  }
  if (bottom > row + 3) {
    screen.put(colA, row + 3, truncate(origin.coords, colAW), "dim");
    screen.put(colB, row + 3, truncate(active.coords, colBW), "dim");
  }

  const logHeader = row + 4;
  const logStart = row + 5;
  const logRows = Math.max(0, progressY - logStart);
  if (logRows > 0) {
    screen.put(colA, logHeader, "EVENT LOG", "dim");
    drawLogs(screen, state.logs, colA, logStart, leftW, logRows);
  }

  screen.put(colA, progressY, "LINK", "dim");
  drawBar(screen, colA + 5, progressY, 10, stats.quality, "bright", "grid");
  screen.put(colA + 17, progressY, `${String(Math.round(stats.quality)).padStart(3)}%`, "bright");
  screen.put(colA + 23, progressY, `LOSS ${String(Math.round(stats.loss * 100)).padStart(2, "0")}%`, stats.loss > 0 ? "warn" : "dim");

  const listTop = dashTop + 2;
  const listRows = Math.max(1, progressY - listTop);
  const maxColumns = clamp(Math.floor((rightW + 1) / 16), 1, 4);
  const neededColumns = Math.max(1, Math.ceil(state.hops.length / listRows));
  const columns = Math.min(maxColumns, neededColumns);
  const columnWidth = Math.floor(rightW / columns);
  const capacity = columns * listRows;
  let start = 0;
  if (state.hops.length > capacity) {
    start = Math.max(0, Math.min(state.hops.length - capacity, state.activeHop - Math.floor(capacity / 2)));
  }

  const headerText =
    columnWidth >= 28
      ? "TTL  NODE             CC   RTT"
      : columnWidth >= 18
        ? "TTL NODE CC RTT"
        : "TTL NODE  RTT";
  for (let column = 0; column < columns; column += 1) {
    const x = rightX + column * columnWidth;
    screen.put(x, dashTop + 1, truncate(headerText, columnWidth - 1), "dim");
  }

  for (let slot = 0; slot < capacity; slot += 1) {
    const hopIndex = start + slot;
    const hop = state.hops[hopIndex];
    if (!hop) continue;
    const column = Math.floor(slot / listRows);
    const line = slot % listRows;
    if (column >= columns) break;
    const x = rightX + column * columnWidth;
    const y = listTop + line;
    const selected = hopIndex === state.activeHop;
    const code = cityCode(hop.city);
    const cc = hop.timedOut ? "--" : (hop.countryCode ?? "--");
    const ttl = `${String(hop.ttl ?? 0).padStart(2, "0")}`;
    const glyph = selected ? "▶" : "·";
    let entry: string;
    if (columnWidth >= 28) {
      const city = truncate(hop.city ?? (hop.local ? "LOCAL GATEWAY" : "UNKNOWN"), 14).padEnd(14);
      entry = `${ttl} ${glyph} ${city} ${cc} ${formatRtt(hop.rttMs).padStart(6)}`;
    } else if (columnWidth >= 18) {
      entry = `${ttl} ${glyph} ${code} ${cc} ${formatRtt(hop.rttMs).padStart(6)}`;
    } else {
      entry = `${ttl} ${code} ${cc} ${formatShortRtt(hop.rttMs).padStart(4)}`;
    }
    const role: StyleRole = hop.timedOut
      ? "warn"
      : selected
        ? "hot"
        : hop.local
          ? "dim"
          : "mid";
    screen.put(x, y, truncate(entry, columnWidth - 1), role);
  }

  screen.put(rightX, progressY, "ROUTE LOCK", "dim");
  drawBar(screen, rightX + 11, progressY, 14, lock, "bright", "grid");
  screen.put(rightX + 27, progressY, `${String(Math.round(lock)).padStart(3)}%`, "bright");
  if (rightW > 38) {
    screen.put(rightX + 34, progressY, `PKT ${String(state.hops.length).padStart(2, "0")}`, "dim");
  }
}

function drawFooter(screen: Screen, state: MissionState, now: number): void {
  const width = screen.width;
  const y = screen.height - 3;
  screen.separator(y, "frame");

  const latest = state.logs.at(-1);
  const ticker =
    state.phase === "locked"
      ? "TARGET LOCKED // ORBITAL SOLUTION CONVERGED"
      : state.phase === "incomplete"
        ? "TRACE ENDED // TARGET NOT REACHED"
        : state.error
          ? `LINK ERROR // ${state.error}`
          : (latest?.text ?? "AWAITING TELEMETRY");
  const hints =
    width >= 112
      ? "[Q]UIT  [SPACE]PAUSE  [R]ETRACE  [T]HEME"
      : width >= 76
        ? "[Q]UIT  [SPACE]PAUSE"
        : "[Q]UIT";
  const available = Math.max(4, width - hints.length - 9);
  const role =
    state.error
      ? "error"
      : state.phase === "incomplete"
        ? "warn"
        : state.phase === "locked"
          ? "hot"
          : latest
            ? logRole(latest.kind)
            : "dim";
  screen.put(2, y + 1, "›", "bright");
  screen.put(4, y + 1, truncate(ticker, available), role);
  const keysStart = width - 2 - hints.length;
  const cursorX = Math.min(4 + Array.from(ticker).length, keysStart - 2);
  if (Math.floor(now / 450) % 2 === 0) screen.put(cursorX + 1, y + 1, "▌", "bright");
  screen.putRight(width - 3, y + 1, hints, "dim");

  screen.put(2, screen.height - 1, `┤ GOLDENEYE TRACE v${VERSION} ├`, "frame");
  screen.putRight(width - 3, screen.height - 1, "[ CLASSIFIED ]", "grid");
}

export function renderFrame(state: MissionState, options: FrameOptions): string[] {
  const width = Math.max(40, Math.floor(options.width));
  const height = Math.max(16, Math.floor(options.height));
  const now = options.now ?? Date.now();
  const color = options.color ?? true;
  const labels = options.labels ?? true;
  const grid = options.grid ?? true;
  const theme = themeByName(options.theme ?? "gold");
  const compact = width < 100 || height < 32;

  const screen = new Screen(width, height);
  screen.box(0, 0, width, height, "frame");
  screen.put(2, 0, "┤ SATELLITE UPLINK TERMINAL ├", "dim");
  screen.putRight(width - 3, 0, "[ CLASSIFIED // 001 ]", "grid");

  const innerW = width - 4;
  const idealMapH = Math.round(innerW * 0.2) + 2;
  const minDash = compact ? 5 : 9;
  const maxMapH = height - 4 - 3 - minDash;
  const mapH = Math.max(8, Math.min(idealMapH, maxMapH));
  const mapTitleY = 4;
  const mapBottom = mapTitleY + mapH - 1;
  const dashTop = mapBottom + 1;

  drawHeader(screen, state, now);
  screen.separator(3, "frame");

  const stations = routeStations(state);
  const active = activePoint(stations, state.reveal);
  const activeIndex = activeStationIndex(stations, state.reveal);
  const activeNode = stations[activeIndex]?.node ?? state.hops.at(-1) ?? state.origin;
  const coords = activeNode ? nodeLine(activeNode).coords : "--";

  drawRule(
    screen,
    mapTitleY,
    "ORBITAL TRACK // SAT-06",
    `${coords}  //  ${state.phase === "locked" ? "TARGET LOCKED" : state.phase === "incomplete" ? "NO LOCK" : state.paused ? "HOLD" : "LIVE FEED"}`,
    state.phase === "locked" ? "hot" : state.phase === "incomplete" ? "warn" : "dim",
  );

  const rect: MapRect = { x: 2, y: mapTitleY + 1, w: innerW, h: mapH - 2 };
  const projection = createProjection(rect.w, rect.h, MAP_BOUNDS);
  const canvas = new BrailleCanvas(rect.w, rect.h);
  drawTerrain(canvas, MAP_BOUNDS, grid);
  drawRoute(canvas, projection, stations, state.reveal, now);
  canvas.render(screen, rect.x, rect.y);

  if (labels) {
    drawMapLabels(screen, rect, projection, stations, state.reveal, active, state.phase, now);
  }

  screen.put(2, mapBottom, "├", "frame");
  screen.hline(3, mapBottom, width - 6, "─", "frame");
  screen.put(width - 3, mapBottom, "┤", "frame");

  drawDashboard(screen, state, stations, dashTop, compact);
  drawFooter(screen, state, now);

  return screen.lines(color, theme);
}
