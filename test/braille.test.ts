import assert from "node:assert/strict";
import { test } from "node:test";
import { BrailleCanvas } from "../src/render/braille.ts";
import { Screen } from "../src/render/screen.ts";

test("route cells do not tint surrounding land dots", () => {
  const canvas = new BrailleCanvas(1, 1);
  // Same character cell: one land dot at x=0, one route dot at x=1.
  canvas.plot(0, 0, 1);
  canvas.plot(1, 0, 4);

  const screen = new Screen(1, 1);
  canvas.render(screen, 0, 0);

  // Only the route dot (0x08) should remain, not land + route (0x09).
  assert.equal(screen.get(0, 0).codePointAt(0), 0x2800 + 0x08);
});

test("keeps neighboring land dots when no route crosses the cell", () => {
  const canvas = new BrailleCanvas(2, 1);
  canvas.plot(0, 0, 1);
  canvas.plot(2, 0, 2);

  const screen = new Screen(2, 1);
  canvas.render(screen, 0, 0);

  assert.equal(screen.get(0, 0).codePointAt(0), 0x2800 + 0x01);
  assert.equal(screen.get(1, 0).codePointAt(0), 0x2800 + 0x01);
});
