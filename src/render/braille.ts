import type { StyleRole } from "../theme.ts";
import type { Screen } from "./screen.ts";

const BRAILLE_BASE = 0x2800;
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

export type CanvasLevel = 0 | 1 | 2 | 3;

const LEVEL_ROLES: Record<CanvasLevel, StyleRole> = {
  0: "grid",
  1: "land",
  2: "coast",
  3: "bright",
};

/**
 * A braille canvas where every character cell holds a 2x4 dot matrix.
 * Dots are effectively square in a 1:2 terminal, which makes this a good
 * fit for equirectangular maps and thin glowing route lines.
 */
export class BrailleCanvas {
  readonly cols: number;
  readonly rows: number;
  readonly dotWidth: number;
  readonly dotHeight: number;
  private readonly bits: Uint8Array;
  private readonly levels: Uint8Array;

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
    this.dotWidth = this.cols * 2;
    this.dotHeight = this.rows * 4;
    this.bits = new Uint8Array(this.cols * this.rows);
    this.levels = new Uint8Array(this.cols * this.rows);
  }

  plot(x: number, y: number, level: CanvasLevel): void {
    const dotX = Math.round(x);
    const dotY = Math.round(y);
    if (dotX < 0 || dotY < 0 || dotX >= this.dotWidth || dotY >= this.dotHeight) return;

    const cellX = Math.floor(dotX / 2);
    const cellY = Math.floor(dotY / 4);
    const localX = dotX % 2;
    const localY = dotY % 4;
    const index = cellY * this.cols + cellX;
    const bit = DOT_BITS[localY]?.[localX] ?? 0;

    const existing = this.bits[index] ?? 0;
    this.bits[index] = existing | bit;
    const current = this.levels[index] ?? 0;
    if (level > current) this.levels[index] = level;
  }

  line(x0: number, y0: number, x1: number, y1: number, level: CanvasLevel): void {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const endX = Math.round(x1);
    const endY = Math.round(y1);
    const dx = Math.abs(endX - x);
    const sx = x < endX ? 1 : -1;
    const dy = -Math.abs(endY - y);
    const sy = y < endY ? 1 : -1;
    let error = dx + dy;

    for (;;) {
      this.plot(x, y, level);
      if (x === endX && y === endY) break;
      const doubled = error * 2;
      if (doubled >= dy) {
        error += dy;
        x += sx;
      }
      if (doubled <= dx) {
        error += dx;
        y += sy;
      }
    }
  }

  circle(centerX: number, centerY: number, radius: number, level: CanvasLevel, dashed = false): void {
    const steps = Math.max(16, Math.round(radius * 8));
    for (let i = 0; i < steps; i += 1) {
      if (dashed && i % 3 !== 0) continue;
      const angle = (i / steps) * Math.PI * 2;
      this.plot(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius, level);
    }
  }

  render(screen: Screen, offsetX: number, offsetY: number): void {
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const index = row * this.cols + col;
        const bits = this.bits[index] ?? 0;
        if (bits === 0) continue;
        const level = (this.levels[index] ?? 0) as CanvasLevel;
        screen.put(offsetX + col, offsetY + row, String.fromCharCode(BRAILLE_BASE + bits), LEVEL_ROLES[level]);
      }
    }
  }
}
