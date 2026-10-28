import { normalizeLon, type GeoPoint } from "./geo.ts";
import type { GeoBounds } from "./map.ts";

export interface MapCamera {
  /** Longitude of the camera center. */
  lon: number;
  /** Latitude of the camera center. */
  lat: number;
  /** Horizontal span in degrees. Smaller means more zoomed in. */
  lonSpan: number;
}

export const WORLD_CAMERA: MapCamera = { lon: 0, lat: 12, lonSpan: 360 };

export const MIN_LON_SPAN = 16;
export const MAX_LON_SPAN = 360;
export const MAP_LAT_SOUTH = -60;
export const MAP_LAT_NORTH = 84;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function distanceToMultiple(value: number, step: number): number {
  const mod = ((value % step) + step) % step;
  return Math.min(mod, step - mod);
}

export function cameraBounds(camera: MapCamera, aspect: number): GeoBounds {
  const lonSpan = clamp(camera.lonSpan, MIN_LON_SPAN, MAX_LON_SPAN);
  if (lonSpan >= MAX_LON_SPAN - 1) {
    return { west: -180, east: 180, south: MAP_LAT_SOUTH, north: MAP_LAT_NORTH };
  }

  const maxLatSpan = MAP_LAT_NORTH - MAP_LAT_SOUTH;
  const latSpan = Math.min(maxLatSpan, lonSpan / Math.max(0.5, aspect));

  let centerLon = clamp(camera.lon, -180 + lonSpan / 2, 180 - lonSpan / 2);
  if (lonSpan >= MAX_LON_SPAN) centerLon = 0;
  const centerLat =
    latSpan >= maxLatSpan
      ? (MAP_LAT_NORTH + MAP_LAT_SOUTH) / 2
      : clamp(camera.lat, MAP_LAT_SOUTH + latSpan / 2, MAP_LAT_NORTH - latSpan / 2);

  return {
    west: centerLon - lonSpan / 2,
    east: centerLon + lonSpan / 2,
    south: centerLat - latSpan / 2,
    north: centerLat + latSpan / 2,
  };
}

/**
 * Fits the camera to a set of visible route points. A single point gets a
 * city-level view. More points widen the view just enough to keep the whole
 * visible route on screen.
 */
export function fitCamera(points: readonly GeoPoint[], aspect: number): MapCamera {
  const valid = points.filter(
    (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon),
  );
  if (valid.length === 0) return { ...WORLD_CAMERA };
  if (valid.length === 1) {
    const only = valid[0];
    if (!only) return { ...WORLD_CAMERA };
    return { lon: only.lon, lat: only.lat, lonSpan: 18 };
  }

  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const point of valid) {
    minLon = Math.min(minLon, point.lon);
    maxLon = Math.max(maxLon, point.lon);
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
  }

  // A route spanning most of the globe, or crossing the antimeridian, is
  // clearer as a full world view than as a stretched local crop.
  if (maxLon - minLon > 300) return { ...WORLD_CAMERA };

  let lonSpan = Math.max(MIN_LON_SPAN, (maxLon - minLon) * 1.35 + 2);
  let latSpan = Math.max(5, (maxLat - minLat) * 1.35 + 2);
  if (lonSpan / latSpan < aspect) {
    lonSpan = latSpan * aspect;
  } else {
    latSpan = lonSpan / aspect;
  }
  if (lonSpan > MAX_LON_SPAN) return { ...WORLD_CAMERA };
  if (latSpan > MAP_LAT_NORTH - MAP_LAT_SOUTH) {
    latSpan = MAP_LAT_NORTH - MAP_LAT_SOUTH;
    lonSpan = Math.min(MAX_LON_SPAN, latSpan * aspect);
  }

  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  return {
    lon: normalizeLon(centerLon),
    lat: clamp(centerLat, MAP_LAT_SOUTH, MAP_LAT_NORTH),
    lonSpan: Math.max(MIN_LON_SPAN, Math.min(MAX_LON_SPAN, lonSpan)),
  };
}

/**
 * Exponential camera smoothing. Zooming is interpolated logarithmically so
 * the perceived zoom speed is even, while the center moves linearly.
 */
export function smoothCamera(
  current: MapCamera,
  target: MapCamera,
  dtMs: number,
  tauMs = 650,
): MapCamera {
  const alpha = 1 - Math.exp(-Math.max(0, dtMs) / Math.max(1, tauMs));
  const currentLog = Math.log(Math.max(1, current.lonSpan));
  const targetLog = Math.log(Math.max(1, target.lonSpan));
  const lonSpan = Math.exp(currentLog + (targetLog - currentLog) * alpha);

  let deltaLon = target.lon - current.lon;
  if (deltaLon > 180) deltaLon -= 360;
  if (deltaLon < -180) deltaLon += 360;
  const lon = normalizeLon(current.lon + deltaLon * alpha);
  const lat = current.lat + (target.lat - current.lat) * alpha;
  return { lon, lat, lonSpan };
}

export { distanceToMultiple };
