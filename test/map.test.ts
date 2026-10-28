import assert from "node:assert/strict";
import { test } from "node:test";
import { createProjection, buildRoutePath } from "../src/map.ts";

const world = { west: -180, east: 180, south: -60, north: 80 };
const projection = createProjection(100, 40, world);

test("projects geographic corners to the edges of the map", () => {
  assert.deepEqual(projection.project({ lat: 80, lon: -180 }), { x: 0, y: 0 });
  assert.deepEqual(projection.project({ lat: -60, lon: 180 }), { x: 99, y: 39 });
});

test("projects the equator and prime meridian to the center", () => {
  const point = projection.project({ lat: 10, lon: 0 });

  assert.equal(point.x, 49.5);
  assert.equal(point.y, 19.5);
});

test("clamps latitudes outside the viewport", () => {
  assert.equal(projection.project({ lat: 89, lon: -179 }).y, 0);
  assert.equal(projection.project({ lat: -89, lon: 179 }).y, 39);
});

test("splits a route that crosses the antimeridian", () => {
  const honolulu = { lat: 21.3069, lon: -157.8583 };
  const tokyo = { lat: 35.6762, lon: 139.6503 };

  const paths = buildRoutePath([honolulu, tokyo], projection);

  assert.equal(paths.length, 2);
  for (const path of paths) {
    for (let i = 1; i < path.length; i += 1) {
      const previous = path[i - 1];
      const current = path[i];
      assert.ok(previous && current);
      assert.ok(Math.abs(current.x - previous.x) < 50, "route should not jump across the map");
    }
  }
});

test("keeps a normal route in one path", () => {
  const stockholm = { lat: 59.3293, lon: 18.0686 };
  const london = { lat: 51.5074, lon: -0.1278 };

  const paths = buildRoutePath([stockholm, london], projection);

  assert.equal(paths.length, 1);
  assert.ok((paths[0]?.length ?? 0) > 8);
});
