import type { ThemeName } from "./types.ts";

export type StyleRole =
  | "frame"
  | "grid"
  | "land"
  | "coast"
  | "dim"
  | "mid"
  | "bright"
  | "accent"
  | "hot"
  | "warn"
  | "error"
  | "ok"
  | "route"
  | "branch";

export interface Theme {
  name: ThemeName;
  colors: Record<StyleRole, readonly [number, number, number]>;
}

export const THEMES: Record<ThemeName, Theme> = {
  gold: {
    name: "gold",
    colors: {
      frame: [112, 76, 16],
      grid: [42, 28, 6],
      land: [70, 46, 9],
      coast: [209, 138, 14],
      dim: [132, 94, 20],
      mid: [198, 138, 20],
      bright: [255, 176, 0],
      accent: [255, 214, 106],
      hot: [255, 244, 198],
      warn: [255, 122, 28],
      error: [255, 77, 61],
      ok: [255, 214, 106],
      route: [255, 59, 48],
      branch: [205, 62, 54],
    },
  },
  green: {
    name: "green",
    colors: {
      frame: [38, 92, 56],
      grid: [14, 38, 24],
      land: [24, 68, 41],
      coast: [74, 190, 114],
      dim: [43, 125, 75],
      mid: [70, 195, 120],
      bright: [102, 255, 166],
      accent: [190, 255, 216],
      hot: [235, 255, 243],
      warn: [255, 194, 71],
      error: [255, 90, 90],
      ok: [126, 255, 178],
      route: [255, 59, 48],
      branch: [205, 62, 54],
    },
  },
  ice: {
    name: "ice",
    colors: {
      frame: [38, 84, 104],
      grid: [14, 38, 50],
      land: [24, 64, 80],
      coast: [74, 180, 214],
      dim: [48, 118, 142],
      mid: [74, 190, 218],
      bright: [104, 228, 255],
      accent: [190, 246, 255],
      hot: [236, 253, 255],
      warn: [255, 196, 92],
      error: [255, 96, 96],
      ok: [140, 240, 255],
      route: [255, 59, 48],
      branch: [205, 62, 54],
    },
  },
};

export function themeByName(name: ThemeName): Theme {
  return THEMES[name] ?? THEMES.gold;
}

export function foreground(theme: Theme, role: StyleRole): string {
  const [r, g, b] = theme.colors[role];
  return `\x1b[38;2;${r};${g};${b}m`;
}
