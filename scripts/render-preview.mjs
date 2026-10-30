import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { demoMission } from "../src/demo.ts";
import { renderBoot } from "../src/render/boot.ts";
import { renderFrame } from "../src/render/frame.ts";

const mode = process.argv[2] ?? "frame";
const theme = process.argv[3] ?? "gold";
const width = Number(process.argv[4] ?? 132);
const height = Number(process.argv[5] ?? 44);
const output = process.argv[6] ?? "docs/preview.png";
const accent = theme === "green" ? "102, 255, 166" : theme === "ice" ? "104, 228, 255" : "255, 176, 0";

const frame =
  mode === "boot"
    ? renderBoot({
        width,
        height,
        color: true,
        now: 1550,
        startedAt: 0,
        theme,
        target: "goldeneye.example",
      })
    : mode === "live"
      ? renderFrame(liveMission(), {
          width,
          height,
          color: true,
          now: 13_200,
          theme,
        })
      : mode === "city"
        ? renderFrame(cityMission(), {
            width,
            height,
            color: true,
            now: 5_200,
            theme,
          })
        : mode === "spike"
          ? renderFrame(demoMission(), {
              width,
              height,
              color: true,
              now: 4_500,
              theme,
              spike: {
                stage: "compose",
                startedAt: 0,
                target: "172.67.205.50",
                ping: null,
              },
            })
          : renderFrame(demoMission(), {
              width,
              height,
              color: true,
              now: 12_400,
              theme,
            });

function cityMission() {
  const state = demoMission();
  state.hops = state.hops.slice(0, 3);
  state.reveal = 0;
  state.activeHop = -1;
  state.phase = "tracing";
  state.finishedAt = null;
  state.traceComplete = false;
  state.logs = [
    { at: 120, kind: "sys", text: "ORBITAL ARRAY ONLINE // SAT-06" },
    { at: 430, kind: "sys", text: "TRACE INITIATED // 11 HOPS MAX" },
    { at: 980, kind: "trace", text: "HOP 01  192.168.10.1  LOCAL GATEWAY" },
    { at: 2140, kind: "geo", text: "NODE 02  STOCKHOLM SE  59.33N 18.07E" },
  ];
  return state;
}

function liveMission() {
  const state = demoMission();
  state.hops = state.hops.slice(0, 8);
  state.reveal = 5.35;
  state.activeHop = 7;
  state.phase = "tracing";
  state.finishedAt = null;
  state.traceComplete = false;
  state.logs = [
    { at: 120, kind: "sys", text: "ORBITAL ARRAY ONLINE // SAT-06" },
    { at: 430, kind: "sys", text: "TRACE INITIATED // 11 HOPS MAX" },
    { at: 980, kind: "trace", text: "HOP 01  192.168.10.1  LOCAL GATEWAY" },
    { at: 2140, kind: "geo", text: "NODE 02  STOCKHOLM SE  59.33N 18.07E" },
    { at: 6240, kind: "geo", text: "NODE 05  LONDON GB  SIGNAL NOMINAL" },
    { at: 9120, kind: "warn", text: "HOP 07  NO RESPONSE  ROUTE CONTINUES" },
    { at: 11_100, kind: "geo", text: "NODE 06  NEW YORK US  40.71N 74.01W" },
    { at: 12_400, kind: "trace", text: "HOP 08  154.54.1.162  128.9 ms" },
  ];
  return state;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function ansiToHtml(line) {
  let html = "";
  let foregroundColor = null;
  let backgroundColor = null;
  const pattern = /\x1b\[(0|39|49|38;2;(\d+);(\d+);(\d+)|48;2;(\d+);(\d+);(\d+))m/g;
  let last = 0;

  const append = (text) => {
    if (!text) return;
    const styles = [];
    if (foregroundColor) styles.push(`color:rgb(${foregroundColor.join(" ")})`);
    if (backgroundColor) styles.push(`background-color:rgb(${backgroundColor.join(" ")})`);
    html += styles.length
      ? `<span style="${styles.join(";")}">${escapeHtml(text)}</span>`
      : escapeHtml(text);
  };

  for (const match of line.matchAll(pattern)) {
    append(line.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;

    if (match[0] === "\x1b[0m") {
      foregroundColor = null;
      backgroundColor = null;
    } else if (match[0] === "\x1b[39m") {
      foregroundColor = null;
    } else if (match[0] === "\x1b[49m") {
      backgroundColor = null;
    } else if (match[2]) {
      foregroundColor = [match[2], match[3], match[4]];
    } else {
      backgroundColor = [match[5], match[6], match[7]];
    }
  }
  append(line.slice(last));
  return html;
}

const body = frame.map(ansiToHtml).join("\n");
const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; --accent: ${accent}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #050301; }
  body {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 26px;
    font-family: "SF Mono", "Berkeley Mono", Menlo, Monaco, monospace;
    background:
      radial-gradient(ellipse at 50% 45%, rgba(var(--accent), .16), transparent 62%),
      #050301;
  }
  .screen {
    position: relative;
    padding: 24px 26px 26px;
    border: 1px solid rgba(var(--accent), .30);
    border-radius: 10px;
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, .8),
      0 0 70px rgba(var(--accent), .10),
      inset 0 0 90px rgba(var(--accent), .035);
    background: rgba(8, 5, 1, .88);
  }
  .screen::before {
    content: "GOLDENEYE // SATELLITE UPLINK — LIVE TRACE";
    position: absolute;
    top: 7px;
    left: 27px;
    font-size: 8px;
    letter-spacing: 2.4px;
    color: rgba(var(--accent), .38);
  }
  pre {
    margin: 0;
    color: rgb(var(--accent));
    font-family: inherit;
    font-size: 12px;
    line-height: 1.12;
    letter-spacing: .2px;
    font-variant-ligatures: none;
    text-shadow: 0 0 5px rgba(var(--accent), .36);
    white-space: pre;
  }
  .scanlines, .vignette {
    position: fixed;
    inset: 0;
    pointer-events: none;
  }
  .scanlines {
    background: repeating-linear-gradient(
      to bottom,
      rgba(0, 0, 0, .17) 0px,
      rgba(0, 0, 0, .17) 1px,
      transparent 1px,
      transparent 3px
    );
    mix-blend-mode: multiply;
  }
  .vignette {
    background: radial-gradient(ellipse at center, transparent 52%, rgba(0, 0, 0, .58) 100%);
  }
</style>
</head>
<body>
  <div class="screen"><pre>${body}</pre></div>
  <div class="scanlines"></div>
  <div class="vignette"></div>
</body>
</html>`;

mkdirSync("docs", { recursive: true });
const htmlPath = resolve("docs/preview.html");
writeFileSync(htmlPath, html);

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
execFileSync(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--window-size=1180,760",
    `--screenshot=${resolve(output)}`,
    `file://${htmlPath}`,
  ],
  { stdio: "ignore" },
);

console.log(`wrote ${output}`);
