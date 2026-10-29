import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkForUpdate,
  compareVersions,
  isNewerVersion,
  updateSteps,
} from "../src/update.ts";

function releaseResponse(tag: string): Response {
  return new Response(
    JSON.stringify({
      tag_name: tag,
      html_url: `https://github.com/LarssonOskar/goldeneye-tracert/releases/tag/${tag}`,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("compares semantic versions", () => {
  assert.equal(compareVersions("v0.6.0", "0.5.2"), 1);
  assert.equal(compareVersions("0.5.2", "v0.5.2"), 0);
  assert.equal(compareVersions("0.5.1", "0.5.2"), -1);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.5.2", "0.5.2"), false);
});

test("finds a newer release and caches it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldeneye-update-"));
  const cachePath = join(directory, "update.json");
  try {
    let calls = 0;
    const info = await checkForUpdate({
      currentVersion: "0.5.2",
      cachePath,
      now: () => 1_000,
      fetchImpl: async () => {
        calls += 1;
        return releaseResponse("v0.6.0");
      },
    });

    assert.equal(info?.latest, "0.6.0");
    assert.equal(info?.current, "0.5.2");
    assert.equal(calls, 1);

    const cached = await checkForUpdate({
      currentVersion: "0.5.2",
      cachePath,
      now: () => 2_000,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("cache should have prevented this request");
      },
    });

    assert.equal(cached?.latest, "0.6.0");
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not report the current or an older release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldeneye-update-"));
  try {
    const same = await checkForUpdate({
      currentVersion: "0.5.2",
      cachePath: join(directory, "same.json"),
      now: () => 1_000,
      fetchImpl: async () => releaseResponse("v0.5.2"),
    });
    assert.equal(same, null);

    const older = await checkForUpdate({
      currentVersion: "0.5.2",
      cachePath: join(directory, "older.json"),
      now: () => 1_000,
      fetchImpl: async () => releaseResponse("v0.5.1"),
    });
    assert.equal(older, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("silently ignores a failed update lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goldeneye-update-"));
  try {
    const info = await checkForUpdate({
      currentVersion: "0.5.2",
      cachePath: join(directory, "update.json"),
      now: () => 1_000,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(info, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("updates the tap before upgrading the formula", () => {
  assert.deepEqual(updateSteps(), [
    { command: "brew", args: ["update"] },
    { command: "brew", args: ["upgrade", "goldeneye-tracert"] },
  ]);
});
