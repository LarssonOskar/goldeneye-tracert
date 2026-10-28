import { gunzipSync } from "node:zlib";
import { LAND_HEIGHT, LAND_MASK_GZIP_BASE64, LAND_WIDTH } from "./data/land.ts";

let cached: Uint8Array | null = null;

export function getLandMask(): Uint8Array {
  if (cached) return cached;
  cached = new Uint8Array(gunzipSync(Buffer.from(LAND_MASK_GZIP_BASE64, "base64")));
  return cached;
}

export function landAt(lat: number, lon: number): boolean {
  const mask = getLandMask();
  const x = Math.max(0, Math.min(LAND_WIDTH - 1, Math.floor(((lon + 180) / 360) * LAND_WIDTH)));
  const y = Math.max(0, Math.min(LAND_HEIGHT - 1, Math.floor(((90 - lat) / 180) * LAND_HEIGHT)));
  return mask[y * LAND_WIDTH + x] === 1;
}

export { LAND_WIDTH, LAND_HEIGHT };
