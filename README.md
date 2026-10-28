# GOLDENEYE TRACERT

> A real traceroute that looks like the satellite-uplink terminal from *GoldenEye*.

[![CI](https://github.com/LarssonOskar/goldeneye-tracert/actions/workflows/ci.yml/badge.svg)](https://github.com/LarssonOskar/goldeneye-tracert/actions/workflows/ci.yml)

```text
╔═┤ GOLDENEYE // SATELLITE UPLINK ├══════════════════════════════════════════════════════╗
║ TARGET goldeneye.example  [203.0.113.7]                [ ● TARGET LOCKED ]             ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ ORBITAL TRACK // SAT-06                                 35.68N 139.65E                 ║
║                                                                                        ║
║       ....  braille world map  ·  glowing great-circle route  ·  reticle ....          ║
║                                                                                        ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ ORIGIN Stockholm, SE   →   ACTIVE Tokyo, JP   268.2ms   ROUTE LOCK 100%                ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ › TARGET LOCKED // ORBITAL SOLUTION CONVERGED                                          ║
╚═┤ GOLDENEYE TRACE v0.1.1 ├═════════════════════════════════════════════════════════════╝
```

![GoldenEye Tracert running a locked demo mission](docs/preview.png)

The route is real. The satellite theater is not.

## What it does

- Runs the system `traceroute` (or `tracert` on Windows) and streams hops into the UI as they arrive.
- Looks up each public hop through [ip-api.com](https://ip-api.com/) in batches, with [ipwho.is](https://ipwho.is/) as a fallback. Results are cached for seven days.
- Locates your own public origin through [ifconfig.co](https://ifconfig.co/), so the route starts where you are.
- Draws a Natural Earth world map in Unicode braille, with a lat/lon graticule, glowing great-circle route, pulsing reticle, city codes and live telemetry.
- Interpolates great-circle arcs and splits them at the antimeridian, so a Honolulu → Tokyo hop wraps across the Pacific instead of cutting across the whole map.
- Reports `TARGET LOCKED` only when the final hop really is the resolved target. Otherwise you get `NO TARGET LOCK`.
- Boots with an orbital-array startup sequence, then lets you pause, retrace and switch themes without leaving the terminal.

![Route being acquired live, with a partial great-circle path and active reticle](docs/preview-live.png)

## Requirements

- **Node.js 22.18 or newer** — the CLI runs TypeScript directly via Node's native type stripping.
- `traceroute` on macOS/Linux, or the built-in `tracert` on Windows.
- A terminal with Unicode braille and truecolor support (Ghostty, iTerm2, WezTerm, Kitty, Apple Terminal, Windows Terminal, etc.).
- Network access for geolocation. Use `--no-geo` for an offline, coordinates-free run; `--demo` works completely offline.

## Quick start

### Homebrew

Homebrew 7 requires third-party taps to be trusted explicitly:

```sh
brew tap LarssonOskar/goldeneye
brew trust LarssonOskar/goldeneye
brew install goldeneye-tracert
goldeneye-tracert --demo
```

The formula lives in [LarssonOskar/homebrew-goldeneye](https://github.com/LarssonOskar/homebrew-goldeneye).

### From source

```sh
git clone https://github.com/LarssonOskar/goldeneye-tracert.git
cd goldeneye-tracert

# no runtime dependencies — just run it
node src/cli.ts --demo

# trace something real
node src/cli.ts 1.1.1.1

# install the command locally
npm install
npm link
goldeneye-tracert example.com --theme green
```

Or run it through npm:

```sh
npm start -- --demo
```

## Usage

```text
goldeneye-tracert <host> [options]
goldeneye-tracert --demo
```

| Flag | Description |
| --- | --- |
| `-d, --demo` | Simulate a round-the-world trace (Stockholm → Tokyo, with a LAN hop and a timeout). |
| `-m, --max-hops <n>` | Maximum hops, 1–64 (default `30`). |
| `-t, --theme <name>` | `gold` (default), `green` or `ice`. |
| `--once` | Render one final frame and exit. Automatic when stdout is not a TTY. |
| `--json` | Print the final mission state as JSON instead of drawing. |
| `--no-geo` | Skip IP geolocation. Useful offline or when you do not want lookups. |
| `--no-color` | Disable ANSI colors. |
| `--beep` | Emit a terminal bell when the target locks. |
| `--width`, `--height` | Override terminal dimensions (handy for screenshots and tests). |
| `-h, --help` | Show help. |
| `-v, --version` | Show the version. |

### Keys

| Key | Action |
| --- | --- |
| `q` / `Esc` / `Ctrl+C` | Close the uplink and restore the terminal. |
| `Space` | Pause / resume the route animation and demo feed. |
| `r` | Retrace the current target. |
| `t` | Cycle gold → green → ice. |
| any key during boot | Skip the boot sequence. |

### Examples

```sh
# classic amber terminal
goldeneye-tracert 8.8.8.8

# a green phosphor run with a longer trace
goldeneye-tracert example.com --max-hops 24 --theme green

# one static, color-free frame for logs or CI
goldeneye-tracert 1.1.1.1 --once --no-color

# keep the JSON around for a later render
goldeneye-tracert --demo --json > mission.json

# no geolocation at all
goldeneye-tracert 1.1.1.1 --no-geo
```

## Themes

| Gold | Green |
| --- | --- |
| ![Gold theme](docs/preview.png) | ![Green theme](docs/preview-green.png) |

Ice: ![Ice theme](docs/preview-ice.png)

## Boot sequence

![GoldenEye Tracert boot sequence](docs/boot.png)

## How it works

1. **Trace** — `src/runner.ts` spawns the platform traceroute binary and parses its output line by line (`src/traceroute.ts`). Header parsing gives us the resolved target IP and hop limit.
2. **Locate** — public hop IPs are batched through ip-api.com. The provider falls back to ipwho.is, caches successful lookups in `~/.cache/goldeneye-tracert/geo.json`, and skips RFC1918/loopback/CGNAT addresses. Your origin is resolved separately.
3. **Project** — `src/geo.ts` computes haversine distances and spherical interpolation. `src/map.ts` maps lat/lon to terminal cells and splits paths where they cross the antimeridian.
4. **Draw** — `src/render/braille.ts` gives each character cell a 2×4 braille dot matrix. `src/render/frame.ts` composes the map, reticle, labels and telemetry panels; `src/render/boot.ts` handles the startup sequence. The whole frame is written to the alternate screen at ~15 fps.
5. **Reveal** — hops are plotted one at a time along their great-circle arcs. When the route reaches the resolved target, the reticle locks; otherwise the trace ends with `NO TARGET LOCK`.

The land mask is generated from [Natural Earth 1:110m land](https://www.naturalearthdata.com/) (public domain) and baked into `src/data/land.ts` as a gzipped mask. To regenerate it:

```sh
npm run build:land
```

## Privacy

- Geolocation sends public hop IPs to ip-api.com (HTTP) and, on failure, ipwho.is (HTTPS). Use `--no-geo` to disable it entirely.
- Nothing is sent anywhere else. The cache is local and can be removed with `rm -rf ~/.cache/goldeneye-tracert`.
- The demo route is entirely fictional and makes no network requests.

## Development

```sh
npm install
npm test           # node:test unit + CLI integration tests
npm run typecheck  # strict TypeScript, no emit
npm start -- --demo
```

The codebase follows a test-driven loop at these seams:

- `parseHopLine` / `parseTracerouteHeader` — real traceroute text formats
- `geo` — haversine, great-circle interpolation, antimeridian behavior
- `map` — projection and route splitting
- `renderFrame` — exact frame dimensions and visible mission state
- `main` — end-to-end CLI behavior with an injected runner and geo provider

Preview screenshots are generated with headless Chrome:

```sh
npm run preview
npm run preview:boot
npm run preview:green
npm run preview:ice
npm run preview:live
```

## Credits

- Inspired by the satellite-uplink computer displays in *GoldenEye* (1995). This is a fan project and is not affiliated with MGM, EON Productions or the James Bond franchise.
- Land data: [Natural Earth](https://www.naturalearthdata.com/), public domain.
- Geolocation: [ip-api.com](https://ip-api.com/) and [ipwho.is](https://ipwho.is/).

## License

MIT
