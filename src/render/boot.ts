import { themeByName } from "../theme.ts";
import { VERSION } from "../version.ts";
import type { ThemeName } from "../types.ts";
import { Screen, truncate } from "./screen.ts";

export interface BootOptions {
  width: number;
  height: number;
  color?: boolean;
  now: number;
  startedAt: number;
  theme?: ThemeName;
  target: string;
}

const LETTERS: Record<string, readonly string[]> = {
  G: [" █████", "█     ", "█  ███", "█    █", " █████"],
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  L: ["█    ", "█    ", "█    ", "█    ", "█████"],
  D: ["████ ", "█   █", "█   █", "█   █", "████ "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  Y: ["█   █", " █ █ ", "  █  ", "  █  ", "  █  "],
};

function logoLines(): string[] {
  const word = "GOLDENEYE";
  const rows: string[] = ["", "", "", "", ""];
  for (let index = 0; index < word.length; index += 1) {
    const glyph = LETTERS[word[index] ?? " "];
    if (!glyph) continue;
    for (let row = 0; row < 5; row += 1) {
      const current = rows[row] ?? "";
      rows[row] = `${current}${glyph[row] ?? ""}${index === word.length - 1 ? "" : "  "}`;
    }
  }
  return rows;
}

const BOOT_STEPS = [
  "ORBITAL ARRAY ......... ONLINE",
  "ENCRYPTION HANDSHAKE .. VERIFIED",
  "GEOSYNC SAT-06 ........ LOCKED",
  "TRACE BUFFER .......... READY",
  "UPLINK ................ ACTIVE",
];

export function renderBoot(options: BootOptions): string[] {
  const width = Math.max(40, Math.floor(options.width));
  const height = Math.max(16, Math.floor(options.height));
  const theme = themeByName(options.theme ?? "gold");
  const color = options.color ?? true;
  const elapsed = Math.max(0, options.now - options.startedAt);
  const screen = new Screen(width, height);
  screen.box(0, 0, width, height, "frame");

  screen.put(2, 0, "┤ GOLDENEYE // BOOT SEQUENCE ├", "dim");
  screen.putRight(width - 3, 0, "[ CLASSIFIED // LEVEL 9 ]", "grid");
  screen.put(2, 2, "SATELLITE UPLINK TERMINAL", "dim");
  screen.putRight(width - 3, 2, "MISSION 001", "grid");
  screen.hline(1, 3, width - 2, "─", "frame");

  const logo = logoLines();
  const showLogo = width >= 64 && height >= 25;
  let cursorY = 5;
  if (showLogo) {
    const logoWidth = Math.max(...logo.map((line) => line.length));
    const logoX = Math.max(2, Math.floor((width - logoWidth) / 2));
    cursorY = Math.max(6, Math.floor(height * 0.27));
    for (let row = 0; row < logo.length; row += 1) {
      const line = logo[row] ?? "";
      screen.put(logoX, cursorY + row, line, row === 2 ? "hot" : "bright");
    }
    cursorY += logo.length + 1;
  } else {
    screen.put(Math.max(2, Math.floor((width - 11) / 2)), 6, "GOLDENEYE", "hot");
    cursorY = 8;
  }

  const subtitle = "◤ SATELLITE UPLINK TERMINAL ◢";
  screen.put(Math.max(2, Math.floor((width - subtitle.length) / 2)), cursorY, subtitle, "mid");
  cursorY += 2;

  const target = `TARGET  ${truncate(options.target, Math.min(40, width - 18)).toUpperCase()}`;
  screen.put(Math.max(2, Math.floor((width - target.length) / 2)), cursorY, target, "dim");
  cursorY += 2;

  const visibleSteps = Math.min(BOOT_STEPS.length, Math.floor(elapsed / 360) + 1);
  const statusWidth = Math.min(46, width - 10);
  const statusX = Math.max(2, Math.floor((width - statusWidth) / 2));
  for (let index = 0; index < visibleSteps; index += 1) {
    const step = BOOT_STEPS[index];
    if (!step) continue;
    const done = elapsed >= (index + 1) * 360;
    screen.put(statusX, cursorY + index, `${done ? "✓" : "›"} ${step}`, done ? "mid" : "bright");
  }
  cursorY += BOOT_STEPS.length + 1;

  const progress = Math.min(1, elapsed / 2100);
  const barWidth = Math.min(26, width - 20);
  const barX = Math.max(2, Math.floor((width - barWidth - 10) / 2));
  screen.put(barX, cursorY, "[", "mid");
  screen.put(barX + 1, cursorY, "█".repeat(Math.round(progress * barWidth)), "bright");
  screen.put(barX + 1 + Math.round(progress * barWidth), cursorY, "░".repeat(barWidth - Math.round(progress * barWidth)), "grid");
  screen.put(barX + barWidth + 2, cursorY, `] ${String(Math.round(progress * 100)).padStart(3)}%`, "hot");

  const message = progress >= 1 ? "LINK ESTABLISHED" : "ESTABLISHING UPLINK";
  if (Math.floor(options.now / 380) % 2 === 0 || progress < 1) {
    screen.put(Math.max(2, Math.floor((width - message.length) / 2)), cursorY + 2, message, progress >= 1 ? "hot" : "bright");
  }

  screen.put(2, height - 3, "AUTH  ████████████████  //  CLEARANCE ACCEPTED", "grid");
  screen.putRight(width - 3, height - 3, "[ PRESS ANY KEY TO SKIP ]", "dim");
  screen.hline(1, height - 2, width - 2, "─", "frame");
  screen.put(2, height - 1, `┤ GOLDENEYE TRACE v${VERSION} ├`, "frame");
  screen.putRight(width - 3, height - 1, "[ CLASSIFIED ]", "grid");

  return screen.lines(color, theme);
}
