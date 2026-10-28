import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "../src/keys.ts";

test("ignores arrow-key sequences", () => {
  assert.equal(stripTerminalSequences("\x1b[A"), "");
  assert.equal(stripTerminalSequences("\x1b[B"), "");
});

test("ignores mouse-wheel and page sequences", () => {
  assert.equal(stripTerminalSequences("\x1b[<64;10;5M"), "");
  assert.equal(stripTerminalSequences("\x1b[5~"), "");
});

test("keeps ordinary keys", () => {
  assert.equal(stripTerminalSequences("q"), "q");
  assert.equal(stripTerminalSequences("\x03"), "\x03");
  assert.equal(stripTerminalSequences("abc\x1b[A"), "abc");
});
