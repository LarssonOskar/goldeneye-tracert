import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cameraBounds,
  fitCamera,
  smoothCamera,
  WORLD_CAMERA,
  type MapCamera,
} from "../src/camera.ts";

const stockholm = { lat: 59.3293, lon: 18.0686 };
const copenhagen = { lat: 55.6761, lon: 12.5683 };
const newYork = { lat: 40.7128, lon: -74.006 };
const aspect = 2.6;

test("fits a city-level camera around a single point", () => {
  const camera = fitCamera([stockholm], aspect);
  const bounds = cameraBounds(camera, aspect);

  assert.ok(camera.lonSpan >= 16 && camera.lonSpan <= 20);
  assert.ok(bounds.west < stockholm.lon && bounds.east > stockholm.lon);
  assert.ok(bounds.south < stockholm.lat && bounds.north > stockholm.lat);
  assert.ok(Math.abs((bounds.east - bounds.west) / (bounds.north - bounds.south) - aspect) < 0.01);
});

test("fits a route and keeps every point inside the view", () => {
  const points = [stockholm, copenhagen, newYork];
  const camera = fitCamera(points, aspect);
  const bounds = cameraBounds(camera, aspect);

  assert.ok(camera.lonSpan > 100, `expected a wider route view, got ${camera.lonSpan}`);
  for (const point of points) {
    assert.ok(point.lon > bounds.west && point.lon < bounds.east, "longitude inside view");
    assert.ok(point.lat > bounds.south && point.lat < bounds.north, "latitude inside view");
  }
});

test("falls back to the world view when the route spans the globe", () => {
  const camera = fitCamera([{ lat: 21.3, lon: -157.8 }, { lat: 35.7, lon: 139.7 }], aspect);

  assert.equal(camera.lonSpan, WORLD_CAMERA.lonSpan);
  const bounds = cameraBounds(camera, aspect);
  assert.ok(bounds.west <= -180 && bounds.east >= 180);
});

test("smoothly interpolates towards the target camera", () => {
  const target: MapCamera = { lon: stockholm.lon, lat: stockholm.lat, lonSpan: 18 };
  const mid = smoothCamera(WORLD_CAMERA, target, 400);
  const later = smoothCamera(mid, target, 1600);

  assert.ok(mid.lonSpan < WORLD_CAMERA.lonSpan);
  assert.ok(mid.lonSpan > target.lonSpan);
  assert.ok(later.lonSpan < mid.lonSpan);
  assert.ok(Math.abs(later.lon - target.lon) < 1);
});
