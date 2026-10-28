import { foreground, type StyleRole, type Theme } from "../theme.ts";

interface Cell {
  ch: string;
  role: StyleRole | null;
}

const RESET = "\x1b[0m";

export class Screen {
  readonly width: number;
  readonly height: number;
  private readonly cells: Cell[];

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.cells = Array.from({ length: this.width * this.height }, () => ({
      ch: " ",
      role: null,
    }));
  }

  private index(x: number, y: number): number {
    return y * this.width + x;
  }

  private inside(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  clear(ch = " ", role: StyleRole | null = null): void {
    for (const cell of this.cells) {
      cell.ch = ch;
      cell.role = role;
    }
  }

  put(x: number, y: number, text: string, role: StyleRole | null = null, maxWidth = Infinity): void {
    if (y < 0 || y >= this.height) return;
    let cursor = Math.floor(x);
    const limit = Math.min(this.width, cursor + Math.max(0, Math.floor(maxWidth)));
    for (const ch of text) {
      if (cursor >= limit) break;
      if (cursor >= 0 && cursor < this.width) {
        const cell = this.cells[this.index(cursor, y)];
        if (cell) {
          cell.ch = ch;
          cell.role = role;
        }
      }
      cursor += 1;
    }
  }

  putRight(xEnd: number, y: number, text: string, role: StyleRole | null = null): void {
    this.put(xEnd - Array.from(text).length + 1, y, text, role);
  }

  fill(x: number, y: number, width: number, height: number, ch: string, role: StyleRole | null = null): void {
    for (let row = y; row < y + height; row += 1) {
      for (let col = x; col < x + width; col += 1) {
        if (this.inside(col, row)) {
          const cell = this.cells[this.index(col, row)];
          if (cell) {
            cell.ch = ch;
            cell.role = role;
          }
        }
      }
    }
  }

  hline(x: number, y: number, width: number, ch: string, role: StyleRole | null = null): void {
    this.put(x, y, ch.repeat(Math.max(0, width)), role);
  }

  vline(x: number, y: number, height: number, ch: string, role: StyleRole | null = null): void {
    for (let row = y; row < y + height; row += 1) {
      this.put(x, row, ch, role);
    }
  }

  box(x: number, y: number, width: number, height: number, role: StyleRole): void {
    if (width < 2 || height < 2) return;
    const right = x + width - 1;
    const bottom = y + height - 1;
    this.put(x, y, "╔", role);
    this.put(right, y, "╗", role);
    this.put(x, bottom, "╚", role);
    this.put(right, bottom, "╝", role);
    this.hline(x + 1, y, width - 2, "═", role);
    this.hline(x + 1, bottom, width - 2, "═", role);
    this.vline(x, y + 1, height - 2, "║", role);
    this.vline(right, y + 1, height - 2, "║", role);
  }

  separator(y: number, role: StyleRole, left = "╠", right = "╣"): void {
    if (y < 0 || y >= this.height) return;
    this.put(0, y, left, role);
    this.put(1, y, "═".repeat(Math.max(0, this.width - 2)), role);
    this.put(this.width - 1, y, right, role);
  }

  get(x: number, y: number): string {
    if (!this.inside(x, y)) return " ";
    return this.cells[this.index(x, y)]?.ch ?? " ";
  }

  isBlank(x: number, y: number): boolean {
    if (!this.inside(x, y)) return false;
    return (this.cells[this.index(x, y)]?.ch ?? " ") === " ";
  }

  lines(color: boolean, theme: Theme): string[] {
    const output: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let line = "";
      let current: StyleRole | null = null;
      for (let x = 0; x < this.width; x += 1) {
        const cell = this.cells[this.index(x, y)];
        if (!cell) continue;
        if (color) {
          if (cell.role !== current) {
            line += cell.role === null ? RESET : foreground(theme, cell.role);
            current = cell.role;
          }
        }
        line += cell.ch;
      }
      if (color && current !== null) line += RESET;
      output.push(line);
    }
    return output;
  }
}

export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= width) return text + " ".repeat(width - chars.length);
  if (width <= 1) return "…";
  return chars.slice(0, width - 1).join("") + "…";
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width <= 1) return "…";
  return chars.slice(0, width - 1).join("") + "…";
}
