import { normalizeLon, sampleGreatCircle, type GeoPoint } from "./geo.ts";

export interface GeoBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

export interface CellPoint {
  x: number;
  y: number;
}

export interface GeoProjection {
  readonly cols: number;
  readonly rows: number;
  readonly bounds: GeoBounds;
  project(point: GeoPoint): CellPoint;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function createProjection(cols: number, rows: number, bounds: GeoBounds): GeoProjection {
  if (cols < 1 || rows < 1) throw new Error("projection needs at least one cell");
  if (bounds.east <= bounds.west) throw new Error("east must be greater than west");
  if (bounds.north <= bounds.south) throw new Error("north must be greater than south");

  return {
    cols,
    rows,
    bounds,
    project(point: GeoPoint): CellPoint {
      const lon =
        point.lon >= bounds.west && point.lon <= bounds.east
          ? point.lon
          : normalizeLon(point.lon);
      return {
        x: clamp(((lon - bounds.west) / (bounds.east - bounds.west)) * (cols - 1), 0, cols - 1),
        y: clamp(
          ((bounds.north - point.lat) / (bounds.north - bounds.south)) * (rows - 1),
          0,
          rows - 1,
        ),
      };
    },
  };
}

/**
 * Samples the route into screen-space polylines. Paths are split where the
 * great circle crosses the antimeridian, so the line never runs across the map.
 */
export function buildRoutePath(
  points: readonly GeoPoint[],
  projection: GeoProjection,
  stepsPerSegment = 96,
): CellPoint[][] {
  const paths: CellPoint[][] = [];

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    if (!from || !to) continue;
    if (from.lat === to.lat && from.lon === to.lon) continue;

    const samples = sampleGreatCircle(from, to, Math.max(8, stepsPerSegment));
    let path: CellPoint[] = [];

    for (let j = 0; j < samples.length; j += 1) {
      const sample = samples[j];
      const previous = samples[j - 1];
      if (!sample) continue;

      if (previous && Math.abs(sample.lon - previous.lon) > 180) {
        if (path.length > 1) paths.push(path);
        path = [];
      }

      path.push(projection.project(sample));
    }

    if (path.length > 1) paths.push(path);
  }

  return paths;
}
