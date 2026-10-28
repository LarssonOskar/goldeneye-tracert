import assert from "node:assert/strict";
import { test } from "node:test";
import { THEMES } from "../src/theme.ts";

test("the route line is red in every theme", () => {
  for (const theme of Object.values(THEMES)) {
    const [red, green, blue] = theme.colors.route;
    assert.ok(red >= 240, `${theme.name}: red channel is ${red}`);
    assert.ok(green <= 90, `${theme.name}: green channel is ${green}`);
    assert.ok(blue <= 90, `${theme.name}: blue channel is ${blue}`);
  }
});
