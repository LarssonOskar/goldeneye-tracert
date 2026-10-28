import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicIp } from "../src/geo-lookup.ts";

test("does not send private or loopback addresses to geolocation", () => {
  for (const ip of [
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fd00::1",
  ]) {
    assert.equal(isPublicIp(ip), false, ip);
  }
});

test("accepts public IPv4 and IPv6 addresses", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "62.119.252.49", "2001:4860:4860::8888"]) {
    assert.equal(isPublicIp(ip), true, ip);
  }
});
