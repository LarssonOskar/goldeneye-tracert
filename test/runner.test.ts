import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SystemTraceRunner } from "../src/runner.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-traceroute.sh", import.meta.url));
chmodSync(fake, 0o755);

test("reads the traceroute header from stderr", { skip: process.platform === "win32" }, async () => {
  const runner = new SystemTraceRunner();
  const result = await runner.run("example.com", { maxHops: 8, command: fake });

  assert.equal(result.header?.ip, "203.0.113.7");
  assert.equal(result.header?.target, "example.com");
  assert.equal(result.hops.length, 3);
  assert.equal(result.hops[1]?.timedOut, true);
});
