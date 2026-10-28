import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  parseHopBlock,
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
    "3",
    "-w",
    "2",
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

      const timeoutMs = Math.max(120_000, options.maxHops * 7000 + 30_000);
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`traceroute timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

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
        let bufferedTtl: number | null = null;
        let bufferedText = "";

        const emitHop = (hop: HopLine): void => {
          if (hops.some((candidate) => candidate.ttl === hop.ttl)) return;
          hops.push(hop);
          options.onHop?.(hop);
        };

        const flushHop = (): void => {
          if (bufferedTtl === null) return;
          const hop = parseHopBlock(bufferedTtl, bufferedText);
          bufferedTtl = null;
          bufferedText = "";
          if (hop) emitHop(hop);
        };

        lines.on("line", (line) => {
          const parsedHeader = parseTracerouteHeader(line);
          if (parsedHeader) {
            flushHop();
            if (!header) {
              header = parsedHeader;
              options.onHeader?.(parsedHeader);
            }
            return;
          }

          const ttlMatch = line.match(/^\s*(\d+)\s+(.*)$/);
          if (ttlMatch) {
            flushHop();
            bufferedTtl = Number(ttlMatch[1]);
            bufferedText = ttlMatch[2] ?? "";
            return;
          }

          // Continuation lines carry the alternate ECMP responders.
          if (bufferedTtl !== null && /^\s+\S/.test(line) && !/^Trace complete/i.test(line.trim())) {
            bufferedText += ` ${line.trim()}`;
            return;
          }

          flushHop();
        });

        lines.on("close", flushHop);
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
