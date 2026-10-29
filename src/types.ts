export type ThemeName = "gold" | "green" | "ice";

export type MissionPhase = "tracing" | "locked" | "incomplete" | "error";

export type LogKind = "sys" | "trace" | "geo" | "warn" | "ok" | "err";

export interface LogLine {
  /** Milliseconds since the mission started. */
  at: number;
  kind: LogKind;
  text: string;
}

export interface AlternateNode {
  ip: string;
  rttMs: number | null;
  city: string | null;
  countryCode: string | null;
  lat: number | null;
  lon: number | null;
}

export interface NodeInfo {
  ttl: number | null;
  ip: string | null;
  rttMs: number | null;
  timedOut: boolean;
  /** True for RFC1918/loopback hops that cannot be geolocated. */
  local: boolean;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  org: string | null;
  asn: string | null;
  lat: number | null;
  lon: number | null;
  /** Number of distinct responders seen at this TTL (ECMP paths). */
  replyCount?: number;
  /** Additional responders at the same TTL, with optional geolocation. */
  alternates?: AlternateNode[];
}

export interface MissionState {
  target: string;
  targetIp: string | null;
  origin: NodeInfo | null;
  hops: NodeInfo[];
  phase: MissionPhase;
  paused: boolean;
  startedAt: number;
  finishedAt: number | null;
  traceComplete: boolean;
  /**
   * Fractional station index on the route. Integer part is the last locked
   * station, the fraction is travel towards the next one.
   */
  reveal: number;
  activeHop: number;
  logs: LogLine[];
  demo: boolean;
  error: string | null;
}

export interface RouteStation {
  node: NodeInfo;
  /** -1 for the origin, otherwise the index into MissionState.hops. */
  hopIndex: number;
}

export function hasLocation(node: NodeInfo): node is NodeInfo & { lat: number; lon: number } {
  return typeof node.lat === "number" && typeof node.lon === "number";
}

export function routeStations(state: MissionState): RouteStation[] {
  const stations: RouteStation[] = [];
  if (state.origin && hasLocation(state.origin)) {
    stations.push({ node: state.origin, hopIndex: -1 });
  }
  state.hops.forEach((hop, hopIndex) => {
    if (hasLocation(hop)) stations.push({ node: hop, hopIndex });
  });
  return stations;
}

export function targetReached(state: MissionState): boolean {
  if (!state.targetIp) return false;
  return state.hops.some(
    (hop) =>
      hop.ip === state.targetIp ||
      (hop.alternates?.some((alternate) => alternate.ip === state.targetIp) ?? false),
  );
}

const CITY_CODES: Record<string, string> = {
  stockholm: "STO",
  copenhagen: "CPH",
  amsterdam: "AMS",
  london: "LON",
  "new york": "NYC",
  dallas: "DFW",
  "los angeles": "LAX",
  honolulu: "HNL",
  tokyo: "TYO",
  sydney: "SYD",
  singapore: "SIN",
  frankfurt: "FRA",
  paris: "PAR",
  madrid: "MAD",
  dublin: "DUB",
  oslo: "OSL",
  helsinki: "HEL",
  reykjavik: "REK",
  "san francisco": "SFO",
  seattle: "SEA",
  chicago: "ORD",
  miami: "MIA",
  toronto: "YTO",
  "são paulo": "SAO",
  "sao paulo": "SAO",
  mumbai: "BOM",
  delhi: "DEL",
  beijing: "BJS",
  shanghai: "SHA",
  seoul: "SEL",
  moscow: "MOW",
  warsaw: "WAW",
  berlin: "BER",
  vienna: "VIE",
  zurich: "ZRH",
  milan: "MIL",
  rome: "ROM",
  lisbon: "LIS",
  atlanta: "ATL",
  denver: "DEN",
  phoenix: "PHX",
  auckland: "AKL",
  "local gateway": "LAN",
};

export function cityCode(city: string | null): string {
  if (!city) return "---";
  const known = CITY_CODES[city.trim().toLowerCase()];
  if (known) return known;
  const cleaned = city.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const letters = cleaned.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return (letters.slice(0, 3) || "---").padEnd(3, " ");
}
