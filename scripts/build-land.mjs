import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const WIDTH = 720;
const HEIGHT = 360;
const SOURCE =
  process.argv[2] ??
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson";
const source = JSON.parse(
  SOURCE.startsWith("http") ? await (await fetch(SOURCE)).text() : readFileSync(SOURCE, "utf8"),
);

const rings = [];
for (const feature of source.features) {
  const geometry = feature.geometry;
  if (!geometry) continue;
  if (geometry.type === "Polygon") {
    rings.push(...geometry.coordinates);
  } else if (geometry.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates) rings.push(...polygon);
  }
}

const mask = new Uint8Array(WIDTH * HEIGHT);

for (let row = 0; row < HEIGHT; row += 1) {
  const lat = 90 - ((row + 0.5) / HEIGHT) * 180;
  const crossings = [];

  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (!a || !b) continue;
      const [lonA, latA] = a;
      const [lonB, latB] = b;
      if (latA === latB) continue;
      if ((latA <= lat && latB > lat) || (latB <= lat && latA > lat)) {
        const t = (lat - latA) / (latB - latA);
        crossings.push(lonA + t * (lonB - lonA));
      }
    }
  }

  crossings.sort((a, b) => a - b);
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const west = crossings[i];
    const east = crossings[i + 1];
    if (west === undefined || east === undefined) continue;
    const start = Math.max(0, Math.round(((west + 180) / 360) * WIDTH));
    const end = Math.min(WIDTH - 1, Math.round(((east + 180) / 360) * WIDTH) - 1);
    for (let col = start; col <= end; col += 1) mask[row * WIDTH + col] = 1;
  }
}

const compressed = gzipSync(Buffer.from(mask), { level: 9 }).toString("base64");
const output = `// Generated from Natural Earth 1:110m land (public domain).
// ${WIDTH}x${HEIGHT} land mask, one byte per cell, gzip + base64.
export const LAND_WIDTH = ${WIDTH};
export const LAND_HEIGHT = ${HEIGHT};
export const LAND_MASK_GZIP_BASE64 =
  "${compressed}";
`;

writeFileSync("src/data/land.ts", output);
console.log(`wrote src/data/land.ts (${(output.length / 1024).toFixed(1)} KiB)`);
