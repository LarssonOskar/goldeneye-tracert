import assert from "node:assert/strict";
import { test } from "node:test";
import {
  haversineKm,
  interpolateGreatCircle,
  routeDistanceKm,
  sampleGreatCircle,
} from "../src/geo.ts";

const stockholm = { lat: 59.3293, lon: 18.0686 };
const london = { lat: 51.5074, lon: -0.1278 };
const honolulu = { lat: 21.3069, lon: -157.8583 };
const tokyo = { lat: 35.6762, lon: 139.6503 };

test("computes great-circle distance between Stockholm and London", () => {
  const km = haversineKm(stockholm, london);

  assert.ok(Math.abs(km - 1436) < 15, `expected ~1436 km, got ${km.toFixed(1)}`);
});

test("interpolates across the antimeridian", () => {
  const midpoint = interpolateGreatCircle(honolulu, tokyo, 0.5);

  assert.ok(Math.abs(midpoint.lat - 32.4) < 1, `lat was ${midpoint.lat}`);
  assert.ok(Math.abs(midpoint.lon - 173.3) < 1, `lon was ${midpoint.lon}`);
});

test("samples a great circle into points with wrapped longitudes", () => {
  const points = sampleGreatCircle(honolulu, tokyo, 48);

  assert.equal(points.length, 48);
  assert.ok(points.every((point) => point.lon >= -180 && point.lon < 180));

  const jumps = points.slice(1).map((point, i) => {
    const previous = points[i];
    assert.ok(previous);
    return Math.abs(point.lon - previous.lon);
  });
  assert.ok(Math.max(...jumps) > 300, "expected the path to cross the antimeridian");
});

test("sums the distance of a route", () => {
  const km = routeDistanceKm([stockholm, london, tokyo]);

  assert.ok(Math.abs(km - (haversineKm(stockholm, london) + haversineKm(london, tokyo))) < 0.001);
});
