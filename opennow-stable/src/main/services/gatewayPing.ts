import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

import type { GatewayPingResult } from "@shared/gfn";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 2_000;

export function parseWindowsDefaultGateway(output: string): string | null {
  const rows = output.split(/\r?\n/);
  let best: { address: string; metric: number } | null = null;
  for (const row of rows) {
    const match = row.trim().match(/^0\.0\.0\.0\s+0\.0\.0\.0\s+((?:\d{1,3}\.){3}\d{1,3})\s+(?:\d{1,3}\.){3}\d{1,3}\s+(\d+)$/);
    if (!match) continue;
    const metric = Number(match[2]);
    if (!best || metric < best.metric) best = { address: match[1]!, metric };
  }
  return best?.address ?? null;
}

export function parseUnixDefaultGateway(output: string): string | null {
  return output.match(/\bdefault\s+via\s+([^\s]+)/)?.[1]
    ?? output.match(/\bgateway:\s*([^\s]+)/i)?.[1]
    ?? null;
}

export function parsePingLatencyMs(output: string): number | null {
  const match = output.match(/(?:time|время|час)[=<]\s*(\d+(?:[.,]\d+)?)\s*(?:ms|мс)/iu);
  if (!match) return null;
  return Number(match[1]!.replace(",", "."));
}

async function discoverDefaultGateway(): Promise<string | null> {
  if (platform() === "win32") {
    const { stdout } = await execFileAsync("route.exe", ["print", "-4", "0.0.0.0"], {
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseWindowsDefaultGateway(stdout);
  }
  if (platform() === "darwin") {
    const { stdout } = await execFileAsync("route", ["-n", "get", "default"], { timeout: COMMAND_TIMEOUT_MS });
    return parseUnixDefaultGateway(stdout);
  }
  const { stdout } = await execFileAsync("ip", ["-4", "route", "show", "default"], { timeout: COMMAND_TIMEOUT_MS });
  return parseUnixDefaultGateway(stdout);
}

export async function pingDefaultGateway(): Promise<GatewayPingResult> {
  const measuredAtMs = Date.now();
  try {
    const gateway = await discoverDefaultGateway();
    if (!gateway) return { measuredAtMs, success: false, latencyMs: null, failure: "gateway-not-found" };
    const args = platform() === "win32"
      ? ["-n", "1", "-w", "1000", gateway]
      : platform() === "darwin"
        ? ["-n", "-c", "1", "-W", "1000", gateway]
        : ["-n", "-c", "1", "-W", "1", gateway];
    const executable = platform() === "win32" ? "ping.exe" : "ping";
    const { stdout } = await execFileAsync(executable, args, {
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      measuredAtMs,
      success: true,
      latencyMs: parsePingLatencyMs(stdout) ?? 0,
      failure: "none",
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    const killed = typeof error === "object" && error !== null && "killed" in error
      ? Boolean((error as { killed?: unknown }).killed)
      : false;
    return {
      measuredAtMs,
      success: false,
      latencyMs: null,
      failure: killed ? "timeout" : code && code !== "1" ? "probe-error" : "unreachable",
    };
  }
}
