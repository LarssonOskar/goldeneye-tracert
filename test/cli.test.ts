import assert from "node:assert/strict";
import { test } from "node:test";
import { main, type CliDeps } from "../src/cli.ts";
import type { GeoProvider, GeoResult } from "../src/geo-lookup.ts";
import type { TraceRunner } from "../src/runner.ts";
import type { HopLine } from "../src/traceroute.ts";
import { VERSION } from "../src/version.ts";

function capture() {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      isTTY: false,
      columns: 120,
      rows: 40,
    },
    text: () => chunks.join(""),
  };
}

const origin: GeoResult = {
  ip: "94.234.75.244",
  city: "Stockholm",
  country: "Sweden",
  countryCode: "SE",
  org: "Telenor",
  asn: "AS2119",
  lat: 59.3293,
  lon: 18.0686,
};

function geoProvider(locations: Record<string, GeoResult>): GeoProvider {
  return {
    async lookup(ips) {
      const result = new Map<string, GeoResult>();
      for (const ip of ips) {
        const geo = locations[ip];
        if (geo) result.set(ip, geo);
      }
      return result;
    },
    async locateSelf() {
      return origin;
    },
  };
}

function runner(hops: HopLine[]): TraceRunner {
  return {
    async run(target, options) {
      const header = { target, ip: "203.0.113.7", maxHops: 12 };
      options.onHeader?.(header);
      for (const hop of hops) options.onHop?.(hop);
      return { header, hops, durationMs: 1 };
    },
  };
}

function deps(out: ReturnType<typeof capture>, trace: TraceRunner, geo: GeoProvider | null): Partial<CliDeps> {
  return {
    stdout: out.stream,
    stderr: out.stream,
    stdin: { isTTY: false },
    env: {},
    now: () => 1000,
    runner: trace,
    geo,
  };
}

const tokyo: GeoResult = {
  ip: "203.0.113.7",
  city: "Tokyo",
  country: "Japan",
  countryCode: "JP",
  org: "GoldenEye Relay",
  asn: "AS64500",
  lat: 35.6762,
  lon: 139.6503,
};

const baseHops: HopLine[] = [
  { ttl: 1, ip: "192.168.1.1", rttMs: 1.2, timedOut: false },
  { ttl: 2, ip: "62.119.252.49", rttMs: 3.4, timedOut: false },
  {
    ttl: 3,
    ip: "203.0.113.7",
    rttMs: 120.5,
    timedOut: false,
    replies: [
      { ip: "203.0.113.7", rttMs: 120.5 },
      { ip: "198.51.100.9", rttMs: 124.2 },
    ],
  },
];

test("runs a trace end to end and renders a locked target", async () => {
  const out = capture();
  const code = await main(
    ["example.com", "--once", "--no-color", "--width", "120", "--height", "40"],
    deps(
      out,
      runner(baseHops),
      geoProvider({
        "62.119.252.49": {
          ...origin,
          ip: "62.119.252.49",
          org: "Telenor Sverige",
        },
        "203.0.113.7": tokyo,
      }),
    ),
  );

  assert.equal(code, 0);
  const text = out.text();
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 40);
  for (const line of lines) assert.equal(line.length, 120);
  assert.match(text, /Tokyo/);
  assert.match(text, /TARGET LOCKED/);
  assert.match(text, /203\.0\.113\.7\s+\+1/);
});

test("reports no target lock when the target is never reached", async () => {
  const out = capture();
  const unreachable: HopLine[] = [
    baseHops[0]!,
    baseHops[1]!,
    { ttl: 3, ip: "198.51.100.9", rttMs: 40.2, timedOut: false },
  ];
  const code = await main(
    ["example.com", "--once", "--no-color", "--width", "120", "--height", "40"],
    deps(
      out,
      runner(unreachable),
      geoProvider({
        "62.119.252.49": {
          ...origin,
          ip: "62.119.252.49",
        },
        "198.51.100.9": {
          ...tokyo,
          ip: "198.51.100.9",
          city: "Amsterdam",
          countryCode: "NL",
          lat: 52.3676,
          lon: 4.9041,
        },
      }),
    ),
  );

  assert.equal(code, 0);
  assert.match(out.text(), /NO TARGET LOCK/);
});

test("prints demo state as JSON", async () => {
  const out = capture();
  const code = await main(
    ["--demo", "--json"],
    {
      stdout: out.stream,
      stderr: out.stream,
      stdin: { isTTY: false },
      env: {},
      now: () => 1000,
      runner: runner([]),
      geo: null,
    },
  );

  assert.equal(code, 0);
  const parsed = JSON.parse(out.text()) as { version: string; state: { phase: string; demo: boolean } };
  assert.equal(parsed.version, VERSION);
  assert.equal(parsed.state.demo, true);
  assert.equal(parsed.state.phase, "locked");
});
