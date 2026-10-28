import assert from "node:assert/strict";
import { test } from "node:test";
import { demoMission } from "../src/demo.ts";
import { renderFrame } from "../src/render/frame.ts";

test("renders a complete demo mission at exactly 120x40", () => {
  const lines = renderFrame(demoMission(), {
    width: 120,
    height: 40,
    color: false,
    now: 10_000,
    theme: "gold",
  });

  assert.equal(lines.length, 40);
  for (const line of lines) {
    assert.equal(line.length, 120, `line is ${line.length} cols: ${JSON.stringify(line)}`);
  }

  const frame = lines.join("\n");
  assert.match(frame, /GOLDENEYE/);
  assert.match(frame, /goldeneye\.example/);
  assert.match(frame, /TARGET LOCKED/i);
  assert.match(frame, /Tokyo/);
});

test("renders without overflowing a compact terminal", () => {
  const lines = renderFrame(demoMission(), {
    width: 80,
    height: 24,
    color: false,
    now: 10_000,
    theme: "green",
  });

  assert.equal(lines.length, 24);
  for (const line of lines) {
    assert.equal(line.length, 80, `line is ${line.length} cols: ${JSON.stringify(line)}`);
  }
  assert.match(lines.join("\n"), /GOLDENEYE/);
});
