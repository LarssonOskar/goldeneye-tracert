import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildTracerouteArgs, SystemTraceRunner } from "../src/runner.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-traceroute.sh", import.meta.url));
chmodSync(fake, 0o755);

test("uses ICMP probes when requested", () => {
  const args = buildTracerouteArgs("example.com", 30, false, "icmp");

  assert.ok(args.includes("-I"));
  assert.ok(args.includes("-q"));
  assert.ok(args.includes("3"));
});

test("keeps UDP probes by default", () => {
  const args = buildTracerouteArgs("example.com", 30, false, "udp");

  assert.ok(!args.includes("-I"));
});

test("Windows tracert does not take a unix probe flag", () => {
  const args = buildTracerouteArgs("example.com", 30, true, "icmp");

  assert.ok(!args.includes("-I"));
  assert.ok(args.includes("-h"));
});

test("reads the traceroute header from stderr", { skip: process.platform === "win32" }, async () => {
  const runner = new SystemTraceRunner();
  const result = await runner.run("example.com", { maxHops: 8, command: fake });

  assert.equal(result.header?.ip, "203.0.113.7");
  assert.equal(result.header?.target, "example.com");
  assert.equal(result.hops.length, 4);
  assert.equal(result.hops[1]?.timedOut, true);
  assert.equal(result.hops[3]?.ip, "62.119.252.49");
  assert.equal(result.hops[3]?.replies?.length, 2);
});
