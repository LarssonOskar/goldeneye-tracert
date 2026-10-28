import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  parseHopLine,
  parseTracerouteHeader,
  type HopLine,
  type TracerouteHeader,
} from "./traceroute.ts";

export interface RunOptions {
  maxHops: number;
  onHop?: (hop: HopLine) => void;
  onHeader?: (header: TracerouteHeader) => void;
  signal?: AbortSignal;
  /** Override the binary, mainly for tests and unusual systems. */
  command?: string;
}

export interface RunResult {
  header: TracerouteHeader | null;
  hops: HopLine[];
  durationMs: number;
}

export interface TraceRunner {
  run(target: string, options: RunOptions): Promise<RunResult>;
}

function buildArgs(target: string, maxHops: number, windows: boolean): string[] {
  const ipv6 = target.includes(":");
  if (windows) {
    return ["-d", "-h", String(maxHops), "-w", "1000", ...(ipv6 ? ["-6"] : []), target];
  }
  return [
    "-n",
    "-q",
    "1",
    "-w",
    "1",
    "-m",
    String(maxHops),
    ...(ipv6 ? ["-6"] : []),
    target,
  ];
}

export class SystemTraceRunner implements TraceRunner {
  async run(target: string, options: RunOptions): Promise<RunResult> {
    const windows = process.platform === "win32";
    const command = options.command ?? (windows ? "tracert" : "traceroute");
    const args = buildArgs(target, options.maxHops, windows);
    const started = Date.now();

    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      const hops: HopLine[] = [];
      let header: TracerouteHeader | null = null;
      let stderr = "";
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve({ header, hops, durationMs: Date.now() - started });
      };

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`traceroute timed out after 120s`));
      }, 120_000);

      const abort = (): void => {
        child.kill("SIGKILL");
        finish(new Error("traceroute aborted"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });

      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          finish(
            new Error(
              `Could not find "${command}". Install traceroute or run with --demo to preview the interface.`,
            ),
          );
        } else {
          finish(error);
        }
      });

      if (child.stderr) {
        const errorLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
        errorLines.on("line", (line) => {
          const parsedHeader = parseTracerouteHeader(line);
          if (parsedHeader) {
            if (!header) {
              header = parsedHeader;
              options.onHeader?.(parsedHeader);
            }
            return;
          }
          stderr += `${line}\n`;
          if (stderr.length > 4000) stderr = stderr.slice(-4000);
        });
      }

      if (child.stdout) {
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on("line", (line) => {
          const parsedHeader = parseTracerouteHeader(line);
          if (parsedHeader) {
            if (!header) {
              header = parsedHeader;
              options.onHeader?.(parsedHeader);
            }
            return;
          }
          const hop = parseHopLine(line);
          if (!hop) return;
          if (hops.some((candidate) => candidate.ttl === hop.ttl)) return;
          hops.push(hop);
          options.onHop?.(hop);
        });
      }

      child.on("close", (code) => {
        options.signal?.removeEventListener("abort", abort);
        if (options.signal?.aborted) {
          finish(new Error("traceroute aborted"));
          return;
        }
        if (code !== 0 && hops.length === 0) {
          finish(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
          return;
        }
        finish();
      });
    });
  }
}

export function createTraceRunner(): TraceRunner {
  return new SystemTraceRunner();
}
