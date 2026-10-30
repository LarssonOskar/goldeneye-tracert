import assert from "node:assert/strict";
import { test } from "node:test";
import { demoMission } from "../src/demo.ts";
import { renderFrame } from "../src/render/frame.ts";

test("renders a complete demo mission at exactly 120x40", () => {
  const lines = renderFrame(demoMission(), {
    width: 120,
    height: 40,
    color: false,
    now: 10_000,
    theme: "gold",
  });

  assert.equal(lines.length, 40);
  for (const line of lines) {
    assert.equal(line.length, 120, `line is ${line.length} cols: ${JSON.stringify(line)}`);
  }

  const frame = lines.join("\n");
  assert.match(frame, /GOLDENEYE/);
  assert.match(frame, /goldeneye\.example/);
  assert.match(frame, /TARGET LOCKED/i);
  assert.match(frame, /Tokyo/);
});

test("renders without overflowing a compact terminal", () => {
  const lines = renderFrame(demoMission(), {
    width: 80,
    height: 24,
    color: false,
    now: 10_000,
    theme: "green",
  });

  assert.equal(lines.length, 24);
  for (const line of lines) {
    assert.equal(line.length, 80, `line is ${line.length} cols: ${JSON.stringify(line)}`);
  }
  assert.match(lines.join("\n"), /GOLDENEYE/);
});

test("zooms in on the first city before the route expands", () => {
  const state = demoMission();
  state.hops = state.hops.slice(0, 3);
  state.reveal = 0;
  state.activeHop = -1;
  state.phase = "tracing";
  state.finishedAt = null;
  state.traceComplete = false;

  const frame = renderFrame(state, {
    width: 120,
    height: 40,
    color: false,
    now: 5000,
    theme: "gold",
  }).join("\n");

  assert.match(frame, /ZOOM 20x/);
  assert.match(frame, /59\.33N 18\.07E/);
});

test("renders a new-target prompt in the footer", () => {
  const lines = renderFrame(demoMission(), {
    width: 120,
    height: 40,
    color: false,
    now: 5000,
    theme: "gold",
    prompt: { label: "NEW TARGET", value: "https://example.com/status" },
  });

  for (const line of lines) assert.equal(line.length, 120);
  const frame = lines.join("\n");
  assert.match(frame, /NEW TARGET/);
  assert.match(frame, /example\.com\/status/);
  assert.match(frame, /\[ENTER\] TRACE/);
});

test("renders the Severnaya spike easter egg", () => {
  const lines = renderFrame(demoMission(), {
    width: 120,
    height: 40,
    color: false,
    now: 4000,
    theme: "gold",
    spike: {
      stage: "compose",
      startedAt: 0,
      target: "172.67.205.50",
      ping: null,
    },
  });

  for (const line of lines) assert.equal(line.length, 120);
  const frame = lines.join("\n");
  assert.match(frame, /SPIKE READY/);
  assert.match(frame, /Better luck next time, slugheads\./);
  assert.match(frame, /BORIS GRISHENKO/);
  assert.match(frame, /PRESS ENTER/);
  assert.match(frame, /\[S\]SPIKE/);
});

test("renders the spike confirmation prompt", () => {
  const frame = renderFrame(demoMission(), {
    width: 120,
    height: 40,
    color: false,
    now: 5000,
    theme: "gold",
    prompt: {
      label: "SEND SPIKE",
      value: "203.0.113.7",
      action: "SEND",
    },
  }).join("\n");

  assert.match(frame, /SEND SPIKE/);
  assert.match(frame, /203\.0\.113\.7/);
  assert.match(frame, /\[ENTER\] SEND/);
  assert.match(frame, /\[ESC\] CANCEL/);
});

test("renders the Severnaya sent box", () => {
  const lines = renderFrame(demoMission(), {
    width: 120,
    height: 40,
    color: false,
    now: 4000,
    theme: "gold",
    spike: {
      stage: "sent",
      startedAt: 0,
      target: "172.67.205.50",
      ping: { ok: true, rttMs: 8.2 },
    },
  });

  for (const line of lines) assert.equal(line.length, 120);
  const frame = lines.join("\n");
  assert.match(frame, /SPIKE SENT/);
  assert.match(frame, /8\.2 ms/);
  assert.doesNotMatch(frame, /Better luck next time/);
});

test("types the Severnaya overlay in over time", () => {
  const linesAt = (now: number): string =>
    renderFrame(demoMission(), {
      width: 120,
      height: 40,
      color: false,
      now,
      theme: "gold",
      spike: {
        stage: "compose",
        startedAt: 0,
        target: "172.67.205.50",
        ping: null,
      },
    }).join("\n");

  const early = linesAt(300);
  assert.doesNotMatch(early, /slugheads/);
  assert.doesNotMatch(early, /BORIS GRISHENKO/);

  const late = linesAt(4000);
  assert.match(late, /Better luck next time, slugheads\./);
  assert.match(late, /BORIS GRISHENKO/);
  assert.doesNotMatch(late, /INVINCIBLE/);
  assert.match(late, /PRESS ENTER/);
});

test("shows an available update in the footer", () => {
  const frame = renderFrame(demoMission(), {
    width: 132,
    height: 44,
    color: false,
    now: 5000,
    theme: "gold",
    update: { version: "0.6.0" },
  }).join("\n");

  assert.match(frame, /\[ UPDATE v0\.6\.0 \]/);
  assert.match(frame, /\[U\]PDATE/);
});
