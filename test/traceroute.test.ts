import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHopLine, parseTracerouteHeader } from "../src/traceroute.ts";

test("parses a macOS traceroute hop", () => {
  const hop = parseHopLine(" 4  62.119.252.49  17.281 ms");

  assert.ok(hop);
  assert.equal(hop.ttl, 4);
  assert.equal(hop.ip, "62.119.252.49");
  assert.equal(hop.rttMs, 17.281);
  assert.equal(hop.timedOut, false);
});

test("marks a silent hop as timed out", () => {
  const hop = parseHopLine(" 3  *");

  assert.ok(hop);
  assert.equal(hop.ttl, 3);
  assert.equal(hop.ip, null);
  assert.equal(hop.rttMs, null);
  assert.equal(hop.timedOut, true);
});

test("parses Windows tracert output", () => {
  const hop = parseHopLine(" 5     8 ms     7 ms     9 ms  172.217.0.1");

  assert.ok(hop);
  assert.equal(hop.ttl, 5);
  assert.equal(hop.ip, "172.217.0.1");
  assert.equal(hop.rttMs, 8);
  assert.equal(hop.timedOut, false);
});

test("resolves the IP from a hostname hop", () => {
  const hop = parseHopLine(" 1  router.local (192.168.1.1)  1.234 ms");

  assert.ok(hop);
  assert.equal(hop.ip, "192.168.1.1");
  assert.equal(hop.rttMs, 1.234);
});

test("marks a fully silent Windows probe as timed out", () => {
  const hop = parseHopLine(" 7     *        *        *     Request timed out.");

  assert.ok(hop);
  assert.equal(hop.timedOut, true);
  assert.equal(hop.ip, null);
});

test("parses an IPv6 hop", () => {
  const hop = parseHopLine(" 3  2001:db8::1  12.4 ms");

  assert.ok(hop);
  assert.equal(hop.ttl, 3);
  assert.equal(hop.ip, "2001:db8::1");
  assert.equal(hop.rttMs, 12.4);
});

test("ignores the traceroute header", () => {
  assert.equal(
    parseHopLine("traceroute to example.com (93.184.216.34), 24 hops max, 52 byte packets"),
    null,
  );
});

test("parses a unix traceroute header", () => {
  const header = parseTracerouteHeader(
    "traceroute to example.com (93.184.216.34), 24 hops max, 52 byte packets",
  );

  assert.deepEqual(header, {
    target: "example.com",
    ip: "93.184.216.34",
    maxHops: 24,
  });
});

test("parses a Windows tracert header", () => {
  const header = parseTracerouteHeader(
    "Tracing route to example.com [93.184.216.34] over a maximum of 30 hops",
  );

  assert.deepEqual(header, {
    target: "example.com",
    ip: "93.184.216.34",
    maxHops: 30,
  });
});
