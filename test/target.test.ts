import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTarget } from "../src/target.ts";

test("normalizes full URLs to hostnames", () => {
  assert.equal(normalizeTarget("https://example.com/path?q=1"), "example.com");
  assert.equal(normalizeTarget("http://user@example.com:8080/x"), "example.com");
});

test("accepts bare hosts and host:port", () => {
  assert.equal(normalizeTarget("example.com"), "example.com");
  assert.equal(normalizeTarget("example.com/path"), "example.com");
  assert.equal(normalizeTarget("example.com:443"), "example.com");
});

test("keeps IPv4 and IPv6 targets", () => {
  assert.equal(normalizeTarget("1.1.1.1"), "1.1.1.1");
  assert.equal(normalizeTarget("2001:db8::1"), "2001:db8::1");
  assert.equal(normalizeTarget("[2001:db8::1]:443"), "2001:db8::1");
});

test("returns an empty string for empty input", () => {
  assert.equal(normalizeTarget("   "), "");
});
