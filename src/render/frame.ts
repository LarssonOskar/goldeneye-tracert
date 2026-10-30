import {
  cameraBounds,
  distanceToMultiple,
  fitCamera,
  type MapCamera,
} from "../camera.ts";
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
import { BrailleCanvas, type CanvasLevel } from "./braille.ts";
import { Screen, truncate } from "./screen.ts";

export interface FooterPrompt {
  label: string;
  value: string;
  /** Verb shown on the Enter hint. Defaults to TRACE. */
  action?: string;
}

export interface SpikePing {
  ok: boolean;
  rttMs: number | null;
}

export interface SpikeOverlay {
  startedAt: number;
  target: string;
  ping: SpikePing | null;
}

export interface UpdateNotice {
  version: string;
}

export interface FrameOptions {
  width: number;
  height: number;
  color?: boolean;
  now?: number;
  theme?: ThemeName;
  labels?: boolean;
  grid?: boolean;
  camera?: MapCamera;
  prompt?: FooterPrompt;
  spike?: SpikeOverlay;
  update?: UpdateNotice;
}

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
    case "spike":
      return "branch";
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

function gridStepForSpan(lonSpan: number): number {
  if (lonSpan >= 300) return 30;
  if (lonSpan >= 120) return 15;
  if (lonSpan >= 50) return 10;
  if (lonSpan >= 22) return 5;
  if (lonSpan >= 8) return 2;
  return 1;
}

function labelStepsForSpan(lonSpan: number): { lon: number; lat: number } {
  if (lonSpan >= 300) return { lon: 60, lat: 30 };
  if (lonSpan >= 120) return { lon: 30, lat: 15 };
  if (lonSpan >= 50) return { lon: 10, lat: 10 };
  if (lonSpan >= 22) return { lon: 5, lat: 5 };
  if (lonSpan >= 8) return { lon: 2, lat: 2 };
  return { lon: 1, lat: 1 };
}

function isGridLine(
  lat: number,
  lon: number,
  step: number,
  latTolerance: number,
  lonTolerance: number,
): boolean {
  return distanceToMultiple(lat, step) < latTolerance || distanceToMultiple(lon, step) < lonTolerance;
}

function drawTerrain(
  canvas: BrailleCanvas,
  bounds: GeoBounds,
  grid: boolean,
  gridStep: number,
): void {
  const mask = getLandMask();
  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  const lonTolerance = (lonSpan / canvas.dotWidth) * 1.1;
  const latTolerance = (latSpan / canvas.dotHeight) * 1.1;
  // Keep roughly the same number of interior land dots regardless of terminal
  // size. Small windows otherwise sample only a faint handful of land cells.
  const landDensity = clamp(
    600 / Math.max(1, canvas.dotWidth * canvas.dotHeight * 0.3),
    0.08,
    0.3,
  );

  const lons = new Float32Array(canvas.dotWidth);
  const lats = new Float32Array(canvas.dotHeight);
  for (let x = 0; x < canvas.dotWidth; x += 1) {
    lons[x] = bounds.west + ((x + 0.5) / canvas.dotWidth) * lonSpan;
  }
  for (let y = 0; y < canvas.dotHeight; y += 1) {
    lats[y] = bounds.north - ((y + 0.5) / canvas.dotHeight) * latSpan;
  }

  // Sample the mask once per braille dot, then derive coastlines from the
  // rendered dot grid. The old fixed mask-radius test left gaps and clusters
  // when the zoom level changed.
  const landDots = new Uint8Array(canvas.dotWidth * canvas.dotHeight);
  for (let y = 0; y < canvas.dotHeight; y += 1) {
    const maskY = clamp(Math.floor(((90 - (lats[y] ?? 0)) / 180) * LAND_HEIGHT), 0, LAND_HEIGHT - 1);
    for (let x = 0; x < canvas.dotWidth; x += 1) {
      const maskX = clamp(
        Math.floor((((lons[x] ?? 0) + 180) / 360) * LAND_WIDTH),
        0,
        LAND_WIDTH - 1,
      );
      if (mask[maskY * LAND_WIDTH + maskX] === 1) {
        landDots[y * canvas.dotWidth + x] = 1;
      }
    }
  }

  for (let y = 0; y < canvas.dotHeight; y += 1) {
    const lat = lats[y] ?? 0;
    for (let x = 0; x < canvas.dotWidth; x += 1) {
      const lon = lons[x] ?? 0;
      const index = y * canvas.dotWidth + x;
      if (landDots[index] === 1) {
        canvas.markLand(x, y);
        let coastal = false;
        for (let dy = -1; dy <= 1 && !coastal; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= canvas.dotWidth || ny >= canvas.dotHeight) continue;
            if (landDots[ny * canvas.dotWidth + nx] === 0) {
              coastal = true;
              break;
            }
          }
        }

        if (coastal) {
          canvas.plot(x, y, 2);
        } else if (noise(x, y) < landDensity) {
          canvas.plot(x, y, 1);
        }
      } else if (
        grid &&
        isGridLine(lat, lon, gridStep, latTolerance, lonTolerance) &&
        (x + y) % 6 === 0
      ) {
        const prime = Math.abs(lat) < latTolerance * 1.2 || Math.abs(lon) < lonTolerance * 1.2;
        canvas.plot(x, y, prime ? 1 : 0);
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
      canvas.line(previousPoint.x * 2, previousPoint.y * 4, point.x * 2, point.y * 4, 4);
    }
    canvas.plot(Math.round(point.x * 2), Math.round(point.y * 4), 4);

    previousSample = sample;
    previousPoint = point;
  }
}

function drawBranchSegment(
  canvas: BrailleCanvas,
  projection: GeoProjection,
  from: NodeInfo,
  to: { lat: number | null; lon: number | null },
): void {
  if (
    typeof from.lat !== "number" ||
    typeof from.lon !== "number" ||
    typeof to.lat !== "number" ||
    typeof to.lon !== "number"
  ) {
    return;
  }

  const steps = 96;
  const samples = sampleGreatCircle(
    { lat: from.lat, lon: from.lon },
    { lat: to.lat, lon: to.lon },
    steps,
  );
  let previousSample: GeoPoint | null = null;
  let previousPoint: { x: number; y: number } | null = null;

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    if (!sample) continue;
    if (previousSample && Math.abs(sample.lon - previousSample.lon) > 180) {
      previousPoint = null;
    }
    const point = projectPoint(projection, sample);
    if (previousPoint && i % 2 === 0) {
      canvas.line(previousPoint.x * 2, previousPoint.y * 4, point.x * 2, point.y * 4, 3);
    }
    previousSample = sample;
    previousPoint = point;
  }
  if (previousPoint) {
    canvas.plot(Math.round(previousPoint.x * 2), Math.round(previousPoint.y * 4), 3);
  }
}

function drawBranches(
  canvas: BrailleCanvas,
  projection: GeoProjection,
  stations: readonly RouteStation[],
  lastIndex: number,
): void {
  for (let i = 0; i <= lastIndex; i += 1) {
    const station = stations[i];
    if (!station) continue;
    const node = station.node;
    if (!node.alternates?.length) continue;
    const previous = i > 0 ? stations[i - 1]?.node : undefined;
    for (const alternate of node.alternates) {
      if (previous) {
        drawBranchSegment(canvas, projection, previous, alternate);
      }
      if (typeof alternate.lat === "number" && typeof alternate.lon === "number") {
        const point = projection.project({ lat: alternate.lat, lon: alternate.lon });
        canvas.plot(Math.round(point.x * 2), Math.round(point.y * 4), 3);
      }
    }
  }
}

function drawRoute(
  canvas: BrailleCanvas,
  projection: GeoProjection,
  stations: readonly RouteStation[],
  reveal: number,
  now: number,
  locked = false,
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

  drawBranches(canvas, projection, stations, index);

  const point = activePoint(stations, reveal);
  if (!point) return;
  const projected = projection.project(point);
  const dotX = projected.x * 2;
  const dotY = projected.y * 4;
  const phase = (now % 1600) / 1600;
  const pulseLevel: CanvasLevel = locked ? 4 : 2;
  const coreLevel: CanvasLevel = locked ? 5 : 4;
  canvas.circle(dotX, dotY, 3 + phase * 9, pulseLevel, true);
  canvas.circle(dotX, dotY, 2, coreLevel, true);
}

export interface MapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapMetrics {
  compact: boolean;
  mapH: number;
  mapTitleY: number;
  mapBottom: number;
  dashTop: number;
  rect: MapRect;
}

export function getMapMetrics(width: number, height: number): MapMetrics {
  const w = Math.max(40, Math.floor(width));
  const h = Math.max(16, Math.floor(height));
  const compact = w < 100 || h < 32;
  const innerW = w - 4;
  const idealMapH = Math.round(innerW * 0.2) + 2;
  const minDash = compact ? 5 : 9;
  const maxMapH = h - 4 - 3 - minDash;
  const mapH = Math.max(8, Math.min(idealMapH, maxMapH));
  const mapTitleY = 4;
  const mapBottom = mapTitleY + mapH - 1;
  const dashTop = mapBottom + 1;
  return {
    compact,
    mapH,
    mapTitleY,
    mapBottom,
    dashTop,
    rect: { x: 2, y: mapTitleY + 1, w: innerW, h: mapH - 2 },
  };
}

/**
 * Camera target for the currently revealed part of the route. The caller can
 * smooth this over time, or let renderFrame use it directly for static frames.
 */
export function cameraForState(state: MissionState, width: number, height: number): MapCamera {
  const metrics = getMapMetrics(width, height);
  const aspect = metrics.rect.w / (metrics.rect.h * 2);
  const stations = routeStations(state);
  const visibleCount = Math.max(1, Math.min(stations.length, Math.ceil(state.reveal) + 1));
  const points: GeoPoint[] = [];
  for (const station of stations.slice(0, visibleCount)) {
    const node = station.node;
    if (typeof node.lat === "number" && typeof node.lon === "number") {
      points.push({ lat: node.lat, lon: node.lon });
    }
    for (const alternate of node.alternates ?? []) {
      if (typeof alternate.lat === "number" && typeof alternate.lon === "number") {
        points.push({ lat: alternate.lat, lon: alternate.lon });
      }
    }
  }
  return fitCamera(points, aspect);
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function formatDegreeLabel(
  value: number,
  step: number,
  positive: string,
  negative: string,
): string {
  const rounded = step < 1 ? Number(value.toFixed(1)) : Math.round(value);
  if (rounded === 0) return "0°";
  const digits = step < 1 ? 1 : 0;
  return `${Math.abs(rounded).toFixed(digits)}${rounded > 0 ? positive : negative}`;
}

function drawMapLabels(
  screen: Screen,
  rect: MapRect,
  projection: GeoProjection,
  bounds: GeoBounds,
  stations: readonly RouteStation[],
  reveal: number,
  active: GeoPoint | null,
  phase: MissionPhase,
  now: number,
): void {
  if (rect.w < 70) return;

  const steps = labelStepsForSpan(bounds.east - bounds.west);
  for (
    let lon = Math.ceil(bounds.west / steps.lon) * steps.lon;
    lon < bounds.east;
    lon += steps.lon
  ) {
    if (lon <= -180 || lon >= 180) continue;
    const point = projection.project({ lat: 0, lon });
    const label = formatDegreeLabel(lon, steps.lon, "E", "W");
    const x = rect.x + Math.round(point.x) - Math.floor(label.length / 2);
    screen.put(x, rect.y + rect.h - 1, label, "dim");
  }

  for (
    let lat = Math.ceil(bounds.south / steps.lat) * steps.lat;
    lat < bounds.north;
    lat += steps.lat
  ) {
    if (lat <= -90 || lat >= 90) continue;
    const point = projection.project({ lat, lon: bounds.west });
    const label = formatDegreeLabel(lat, steps.lat, "N", "S");
    screen.put(rect.x, rect.y + Math.round(point.y), label, "dim");
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

  const lastStation = Math.min(activeStationIndex(stations, reveal), stations.length - 1);
  for (let i = 0; i <= lastStation; i += 1) {
    const node = stations[i]?.node;
    if (!node) continue;
    for (const alternate of node.alternates ?? []) {
      if (typeof alternate.lat !== "number" || typeof alternate.lon !== "number") continue;
      const point = projection.project({ lat: alternate.lat, lon: alternate.lon });
      const x = rect.x + Math.round(point.x);
      const y = rect.y + Math.round(point.y);
      if (occupied.has(key(x, y))) continue;
      screen.put(x, y, "·", "branch");
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
    const rttText = activeNode && activeNode.ttl !== null ? formatRtt(activeNode.rttMs) : "--";
    const cityWidth = colBW > 17 ? colBW - rttText.length - 2 : colBW;
    screen.put(colB, row + 1, truncate(active.city, cityWidth), "hot");
    if (colBW > 17) screen.put(colB + colBW - rttText.length, row + 1, rttText, "accent");
  }
  if (bottom > row + 2) {
    screen.put(colA, row + 2, truncate(origin.org, colAW), "dim");
    const ip = activeNode?.ip ? `${activeNode.ip}` : "--";
    const extraPaths = Math.max(0, (activeNode?.replyCount ?? 1) - 1);
    const ipText = extraPaths > 0 ? `${ip}  +${extraPaths}` : ip;
    screen.put(colB, row + 2, truncate(ipText, colBW), "bright");
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

function drawFooter(
  screen: Screen,
  state: MissionState,
  now: number,
  prompt?: FooterPrompt,
  update?: UpdateNotice,
): void {
  const width = screen.width;
  const y = screen.height - 3;
  screen.separator(y, "frame");

  const updateHint = update ? "  [U]PDATE" : "";
  const hints = prompt
    ? width >= 96
      ? `[ENTER] ${prompt.action ?? "TRACE"}  [ESC] CANCEL`
      : width >= 64
        ? `[ENTER] ${prompt.action === "SEND" ? "SEND" : "GO"}  [ESC] CANCEL`
        : "[↵] GO  [ESC]"
    : width >= 112
      ? `${
          state.phase === "locked"
            ? "[Q]UIT  [SPACE]PAUSE  [R]ETRACE  [N]EW  [T]HEME  [S]SPIKE"
            : "[Q]UIT  [SPACE]PAUSE  [R]ETRACE  [N]EW  [T]HEME"
        }${updateHint}`
      : width >= 76
        ? "[Q]UIT  [SPACE]PAUSE  [N]EW"
        : "[Q]UIT";

  if (prompt) {
    const label = `${prompt.label} > `;
    const labelWidth = Math.min(18, label.length);
    const valueX = 4 + labelWidth;
    const valueWidth = Math.max(4, width - hints.length - valueX - 4);
    const value =
      prompt.value.length > valueWidth
        ? `…${prompt.value.slice(-(valueWidth - 1))}`
        : prompt.value;
    screen.put(2, y + 1, "›", "bright");
    screen.put(4, y + 1, truncate(label, labelWidth), "dim");
    screen.put(valueX, y + 1, value, "hot");
    screen.put(valueX + value.length, y + 1, "▌", "bright");
  } else {
    const latest = state.logs.at(-1);
    const ticker =
      state.phase === "locked"
        ? "TARGET LOCKED // ORBITAL SOLUTION CONVERGED"
        : state.phase === "incomplete"
          ? "TRACE ENDED // TARGET NOT REACHED"
          : state.error
            ? `LINK ERROR // ${state.error}`
            : (latest?.text ?? "AWAITING TELEMETRY");
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
  }
  screen.putRight(width - 3, y + 1, hints, "dim");

  screen.put(2, screen.height - 1, `┤ GOLDENEYE TRACE v${VERSION} ├`, "frame");
  if (update && width >= 60) {
    screen.putRight(width - 3, screen.height - 1, `[ UPDATE v${update.version} ]`, "warn");
  } else {
    screen.putRight(width - 3, screen.height - 1, "[ CLASSIFIED ]", "grid");
  }
}

function drawSpikeOverlay(screen: Screen, spike: SpikeOverlay, now: number): void {
  const width = Math.min(68, screen.width - 6);
  const height = 10;
  if (width < 52 || screen.height < 20) return;

  const x = Math.floor((screen.width - width) / 2);
  const y = Math.max(2, Math.floor((screen.height - 3 - height) / 2));
  const elapsed = Math.max(0, now - spike.startedAt);
  const left = x + 3;
  const right = x + width - 4;

  const typed = (value: string, start: number, msPerChar: number): string => {
    const count = Math.floor((elapsed - start) / msPerChar);
    if (count <= 0) return "";
    return value.slice(0, Math.min(value.length, count));
  };

  screen.fill(x, y, width, height, " ", null);
  screen.box(x, y, width, height, "branch");

  screen.put(left, y, typed("┤ SPIKE SENT ├", 0, 22), "hot");
  const place = "SEVERNAYA // 1995";
  screen.put(right - place.length, y, typed(place, 260, 18), "dim");

  screen.put(left, y + 1, typed("SATELLITE SPIKE // SAT-06", 380, 15), "dim");
  const blocked = "COUNTER-TRACE BLOCKED";
  screen.put(right - blocked.length, y + 1, typed(blocked, 560, 13), "warn");

  if (elapsed > 700) {
    const waveWidth = width - 6;
    const reveal = clamp(Math.floor(((elapsed - 700) / 900) * waveWidth), 1, waveWidth);
    const phase = Math.floor(elapsed / 70);
    const levels = "▁▂▃▄▅▆▇█";
    for (let i = 0; i < reveal; i += 1) {
      const position = i / Math.max(1, waveWidth - 1);
      const peak = Math.exp(-Math.pow((position - 0.5) * 7, 2));
      const wobble = (Math.sin((i + phase) * 0.6) + 1) / 2;
      const level = Math.round(Math.max(0, Math.min(7, peak * 7 + wobble * 0.8)));
      const role: StyleRole = level >= 6 ? "hot" : level >= 3 ? "route" : "branch";
      screen.put(left - 1 + i, y + 2, levels[level] ?? "▁", role);
    }
  }

  screen.put(left, y + 3, typed("DATA SPIKE", 1000, 20), "hot");
  screen.put(
    left + 11,
    y + 3,
    typed("// ACTIVE", 1200, 16),
    Math.floor(elapsed / 220) % 2 === 0 ? "warn" : "dim",
  );
  const slug = "SLUGHEADS.EXE";
  screen.put(right - slug.length, y + 3, typed(slug, 900, 16), "branch");

  const quote = "Better luck next time, slugheads.";
  const revealed = Math.min(quote.length, Math.max(0, Math.floor((elapsed - 1400) / 26)));
  const visibleQuote = quote.slice(0, revealed);
  screen.put(x + 4, y + 5, `"${visibleQuote}`, "hot");
  if (revealed < quote.length) {
    screen.put(x + 5 + visibleQuote.length, y + 5, "▌", "bright");
  } else {
    screen.put(x + 5 + quote.length, y + 5, "\"", "hot");
  }

  if (elapsed > 2300) {
    const signature = "— BORIS GRISHENKO";
    screen.put(right - signature.length, y + 6, typed(signature, 2300, 16), "dim");
  }

  if (elapsed > 1400) {
    const target = truncate(spike.target, Math.max(12, width - 27));
    screen.put(left, y + 8, typed("PING", 1400, 20), "dim");
    screen.put(left + 6, y + 8, typed(target, 1450, 14), "mid");
    if (spike.ping === null) {
      screen.put(right - 9, y + 8, typed("WAITING //", 1600, 18), "dim");
    } else if (spike.ping.ok) {
      const status = `${spike.ping.rttMs === null ? "--" : spike.ping.rttMs.toFixed(1)} ms  //  ACK`;
      screen.put(right - status.length, y + 8, typed(status, 1800, 12), "hot");
    } else {
      const status = "NO ACK";
      screen.put(right - status.length, y + 8, typed(status, 1800, 16), "warn");
    }
  }
}

export function renderFrame(state: MissionState, options: FrameOptions): string[] {
  const width = Math.max(40, Math.floor(options.width));
  const height = Math.max(16, Math.floor(options.height));
  const now = options.now ?? Date.now();
  const color = options.color ?? true;
  const labels = options.labels ?? true;
  const grid = options.grid ?? true;
  const theme = themeByName(options.theme ?? "gold");
  const metrics = getMapMetrics(width, height);
  const { compact, mapTitleY, mapBottom, dashTop, rect } = metrics;

  const screen = new Screen(width, height);
  screen.box(0, 0, width, height, "frame");
  screen.put(2, 0, "┤ SATELLITE UPLINK TERMINAL ├", "dim");
  screen.putRight(width - 3, 0, "[ CLASSIFIED // 001 ]", "grid");

  drawHeader(screen, state, now);
  screen.separator(3, "frame");

  const stations = routeStations(state);
  const active = activePoint(stations, state.reveal);
  const activeIndex = activeStationIndex(stations, state.reveal);
  const activeNode = stations[activeIndex]?.node ?? state.hops.at(-1) ?? state.origin;
  const coords = activeNode ? nodeLine(activeNode).coords : "--";
  const camera = options.camera ?? cameraForState(state, width, height);
  const aspect = rect.w / (rect.h * 2);
  const bounds = cameraBounds(camera, aspect);
  const zoom = 360 / (bounds.east - bounds.west);
  const zoomLabel = zoom >= 10 ? `${Math.round(zoom)}x` : `${zoom.toFixed(1)}x`;

  drawRule(
    screen,
    mapTitleY,
    `ORBITAL TRACK // SAT-06 // ZOOM ${zoomLabel}`,
    `${coords}  //  ${state.phase === "locked" ? "TARGET LOCKED" : state.phase === "incomplete" ? "NO LOCK" : state.paused ? "HOLD" : "LIVE FEED"}`,
    state.phase === "locked" ? "hot" : state.phase === "incomplete" ? "warn" : "dim",
  );

  const gridStep = gridStepForSpan(bounds.east - bounds.west);
  const projection = createProjection(rect.w, rect.h, bounds);
  const canvas = new BrailleCanvas(rect.w, rect.h);
  drawTerrain(canvas, bounds, grid, gridStep);
  drawRoute(canvas, projection, stations, state.reveal, now, state.phase === "locked");
  canvas.render(screen, rect.x, rect.y);

  if (labels) {
    drawMapLabels(screen, rect, projection, bounds, stations, state.reveal, active, state.phase, now);
  }

  screen.put(2, mapBottom, "├", "frame");
  screen.hline(3, mapBottom, width - 6, "─", "frame");
  screen.put(width - 3, mapBottom, "┤", "frame");

  drawDashboard(screen, state, stations, dashTop, compact);
  if (options.spike) drawSpikeOverlay(screen, options.spike, now);
  drawFooter(screen, state, now, options.prompt, options.update);

  return screen.lines(color, theme);
}
