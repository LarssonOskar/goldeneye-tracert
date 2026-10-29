import assert from "node:assert/strict";
import { test } from "node:test";
import { Screen } from "../src/render/screen.ts";
import { THEMES } from "../src/theme.ts";

test("renders foreground and background colors independently", () => {
  const screen = new Screen(2, 1);
  screen.put(0, 0, "L", "land");
  screen.setBackground(0, 0, "landBg");
  screen.put(1, 0, "W", "grid");

  const line = screen.lines(true, THEMES.gold)[0] ?? "";

  assert.match(line, /\x1b\[48;2;35;23;5m/);
  assert.match(line, /\x1b\[38;2;70;46;9m/);
  assert.match(line, /\x1b\[49m/);
  assert.match(line, /\x1b\[0m$/);
});

test("text clears the background of its cell", () => {
  const screen = new Screen(1, 1);
  screen.setBackground(0, 0, "landBg");
  screen.put(0, 0, "X", "bright");

  const line = screen.lines(true, THEMES.gold)[0] ?? "";
  assert.doesNotMatch(line, /\x1b\[48;/);
});
