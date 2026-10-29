import { spawn } from "node:child_process";

export interface PingResult {
  ok: boolean;
  rttMs: number | null;
}

export function parsePingRtt(output: string): number | null {
  const match = output.match(/time[=<]?\s*([\d.]+)\s*ms/i);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

export function buildPingArgs(
  target: string,
  timeoutMs: number,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "win32") {
    return ["-n", "1", "-w", String(timeoutMs), target];
  }
  if (platform === "darwin") {
    return ["-c", "1", "-n", "-W", String(timeoutMs), target];
  }
  return ["-c", "1", "-n", "-W", String(Math.max(1, Math.ceil(timeoutMs / 1000))), target];
}

/**
 * One-shot ICMP echo, used by the Severnaya spike easter egg. Failure is a
 * valid result: the overlay still plays and reports NO ACK.
 */
export function pingOnce(
  target: string,
  timeoutMs = 1500,
  options: { command?: string; platform?: NodeJS.Platform } = {},
): Promise<PingResult> {
  const platform = options.platform ?? process.platform;
  const command = options.command ?? "ping";
  const args = buildPingArgs(target, timeoutMs, platform);

  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;

    const finish = (result: PingResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, rttMs: null });
    }, timeoutMs + 500);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", () => finish({ ok: false, rttMs: null }));
    child.on("close", (code) => {
      const rttMs = parsePingRtt(output);
      finish({ ok: code === 0 && (rttMs !== null || /bytes from/i.test(output)), rttMs });
    });
  });
}
