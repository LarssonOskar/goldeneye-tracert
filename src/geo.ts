export interface GeoPoint {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

function toRadians(degrees: number): number {
  return degrees * DEG;
}

function toDegrees(radians: number): number {
  return radians / DEG;
}

export function normalizeLon(lon: number): number {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRadians(b.lon - a.lon);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

function toCartesian(point: GeoPoint): Vector3 {
  const lat = toRadians(point.lat);
  const lon = toRadians(point.lon);
  return {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.cos(lat) * Math.sin(lon),
    z: Math.sin(lat),
  };
}

function fromCartesian(vector: Vector3): GeoPoint {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  const x = vector.x / length;
  const y = vector.y / length;
  const z = vector.z / length;
  return {
    lat: toDegrees(Math.asin(Math.max(-1, Math.min(1, z)))),
    lon: normalizeLon(toDegrees(Math.atan2(y, x))),
  };
}

/**
 * Spherical linear interpolation between two points. Follows the shortest
 * great-circle arc, so routes across the Pacific wrap correctly.
 */
export function interpolateGreatCircle(a: GeoPoint, b: GeoPoint, t: number): GeoPoint {
  if (t <= 0) return a;
  if (t >= 1) return b;

  const from = toCartesian(a);
  const to = toCartesian(b);
  const dot = Math.max(-1, Math.min(1, from.x * to.x + from.y * to.y + from.z * to.z));
  const theta = Math.acos(dot);

  if (theta < 1e-9) return a;

  const sinTheta = Math.sin(theta);
  if (sinTheta < 1e-9) {
    return {
      lat: a.lat + (b.lat - a.lat) * t,
      lon: normalizeLon(a.lon + (normalizeLon(b.lon - a.lon + 180) - 180) * t),
    };
  }

  const scaleFrom = Math.sin((1 - t) * theta) / sinTheta;
  const scaleTo = Math.sin(t * theta) / sinTheta;
  return fromCartesian({
    x: from.x * scaleFrom + to.x * scaleTo,
    y: from.y * scaleFrom + to.y * scaleTo,
    z: from.z * scaleFrom + to.z * scaleTo,
  });
}

export function sampleGreatCircle(a: GeoPoint, b: GeoPoint, steps: number): GeoPoint[] {
  const count = Math.max(2, Math.floor(steps));
  const points: GeoPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    points.push(interpolateGreatCircle(a, b, i / (count - 1)));
  }
  return points;
}

export function routeDistanceKm(points: readonly GeoPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous && current) total += haversineKm(previous, current);
  }
  return total;
}

export function formatCoordinate(point: GeoPoint): string {
  const lat = `${Math.abs(point.lat).toFixed(2)}${point.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(point.lon).toFixed(2)}${point.lon >= 0 ? "E" : "W"}`;
  return `${lat} ${lon}`;
}
