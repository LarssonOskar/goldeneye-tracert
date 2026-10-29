import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildPingArgs, parsePingRtt, pingOnce } from "../src/ping.ts";

test("parses ping latency", () => {
  assert.equal(parsePingRtt("64 bytes from 1.1.1.1: time=8.23 ms"), 8.23);
  assert.equal(parsePingRtt("Reply from 1.1.1.1: time=7ms"), 7);
  assert.equal(parsePingRtt("no response"), null);
});

test("builds platform-specific ping arguments", () => {
  assert.ok(buildPingArgs("example.com", 1500, "darwin").includes("-W"));
  assert.ok(buildPingArgs("example.com", 1500, "win32").includes("-n"));
  assert.ok(buildPingArgs("example.com", 1500, "linux").includes("-c"));
});

test("runs a one-shot ping", { skip: process.platform === "win32" }, async () => {
  const fake = fileURLToPath(new URL("./fixtures/fake-ping.sh", import.meta.url));
  chmodSync(fake, 0o755);

  const result = await pingOnce("1.1.1.1", 1500, { command: fake });

  assert.equal(result.ok, true);
  assert.equal(result.rttMs, 8.23);
});
