import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  DiagnosticsSessionSaveRequest,
  DiagnosticsSessionSaveResult,
  NetworkRecoveryProfile,
} from "@shared/gfn";

type JsonObject = Record<string, unknown>;
type ProblemCategory = "local_network" | "route_or_nvidia" | "decoder_or_keyframe" | "undetermined";

interface DiagnosticEvent {
  timestamp: string;
  elapsedMs: number;
  type: string;
  detail: string;
  values?: Record<string, number | string | boolean>;
}

interface ActiveCheckpoint {
  captureId: string;
  updatedAt: string;
  report: JsonObject;
}

interface TerminationOverride {
  reasonCode: string;
  detail: string;
  source: "application" | "renderer_crash";
}

const ACTIVE_CHECKPOINT_FILE = "active-session-diagnostics.json";
const MAX_REPORT_BYTES = 24 * 1024 * 1024;

export class StreamDiagnosticsPersistence {
  private readonly completedCaptureIds = new Set<string>();
  private active: ActiveCheckpoint | null = null;
  private operation: Promise<unknown> = Promise.resolve();
  private temporaryFileSequence = 0;

  constructor(private readonly directory: string) {}

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true });
      this.active = await this.readActiveCheckpoint();
      if (this.active) {
        await this.finalizeActive({
          source: "application",
          reasonCode: "previous_process_terminated",
          detail: "OpenNOW terminated before the active diagnostics session was finalized",
        });
      }
    });
  }

  save(input: DiagnosticsSessionSaveRequest): Promise<DiagnosticsSessionSaveResult> {
    return this.enqueue(async () => {
      const report = validateReport(input.report);
      const captureId = captureIdFor(report);
      if (this.completedCaptureIds.has(captureId)) {
        return { fullDiagnosticsPath: null, summaryPath: null };
      }

      if (this.active && this.active.captureId !== captureId) {
        await this.finalizeActive({
          source: "application",
          reasonCode: "superseded_by_new_session",
          detail: "A new streaming session started before the previous diagnostics session was finalized",
        });
      }

      this.active = {
        captureId,
        updatedAt: new Date().toISOString(),
        report,
      };
      await this.writeJsonAtomic(this.activePath(), this.active);

      if (input.phase === "completed") {
        return this.finalizeActive();
      }
      return { fullDiagnosticsPath: null, summaryPath: null };
    });
  }

  finalizeUnexpected(
    reasonCode: string,
    detail: string,
    source: TerminationOverride["source"] = "renderer_crash",
  ): Promise<DiagnosticsSessionSaveResult> {
    return this.enqueue(async () => {
      this.active ??= await this.readActiveCheckpoint();
      return this.finalizeActive({ reasonCode, detail, source });
    });
  }

  private async finalizeActive(
    termination?: TerminationOverride,
  ): Promise<DiagnosticsSessionSaveResult> {
    if (!this.active) {
      return { fullDiagnosticsPath: null, summaryPath: null };
    }

    const active = this.active;
    const report = termination
      ? appendSessionExit(active.report, termination)
      : active.report;
    const suffix = fileTimestamp(active.captureId);
    const fullDiagnosticsPath = join(this.directory, "opennow-diagnostics-" + suffix + ".json");
    const summaryPath = join(this.directory, "opennow-summary-" + suffix + ".json");
    const summary = buildCompactDiagnosticsSummary(report, fullDiagnosticsPath);

    await this.writeJsonAtomic(fullDiagnosticsPath, report);
    await this.writeJsonAtomic(summaryPath, summary);
    await rm(this.activePath(), { force: true });
    this.completedCaptureIds.add(active.captureId);
    this.active = null;
    return { fullDiagnosticsPath, summaryPath };
  }

  private async readActiveCheckpoint(): Promise<ActiveCheckpoint | null> {
    try {
      const parsed = JSON.parse(await readFile(this.activePath(), "utf8")) as Partial<ActiveCheckpoint>;
      if (typeof parsed.captureId !== "string" || !isJsonObject(parsed.report)) return null;
      return {
        captureId: parsed.captureId,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        report: parsed.report,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private activePath(): string {
    return join(this.directory, ACTIVE_CHECKPOINT_FILE);
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) {
      throw new Error("Diagnostics report exceeds the 24 MiB persistence limit");
    }
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = path + ".tmp-" + process.pid + "-" + ++this.temporaryFileSequence;
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => undefined);
    return next;
  }
}

export function buildCompactDiagnosticsSummary(
  report: JsonObject,
  fullDiagnosticsPath: string,
): JsonObject {
  const events = readEvents(report.events);
  const rollup = readDiagnosticsRollup(report.rollup);
  const context = isJsonObject(report.context) ? report.context : {};
  const exit = findLast(events, (event) => event.type === "SESSION_EXIT");
  const failureAtMs = exit ? Date.parse(exit.timestamp) : Date.parse(stringValue(report.captureFinishedAt));
  const rtpLoss = rollup?.rtpLoss ?? buildRtpLossSummary(events);
  const captureStartedMs = Date.parse(stringValue(report.captureStartedAt));
  const captureElapsedMs = Number.isFinite(failureAtMs) && Number.isFinite(captureStartedMs)
    ? Math.max(0, failureAtMs - captureStartedMs)
    : null;
  if (captureElapsedMs !== null) {
    for (const incident of rtpLoss) {
      incident.durationMs ??= Math.max(0, captureElapsedMs - incident.startedElapsedMs);
    }
  }
  const primaryLoss = [...rtpLoss].sort((a, b) => b.packetsLostDelta - a.packetsLostDelta)[0] ?? null;
  const gatewayAtFailure = findNearestGateway(events, failureAtMs);
  const keyframeRequestEvents = rollup?.keyframeRequests
    ?? events.filter((event) => event.type.startsWith("KEYFRAME_REQUEST")).slice(-20);
  const keyframeRequests = keyframeRequestEvents.map(compactEvent);
  const decodedKeyframes = rollup?.decodedKeyframes
    ?? events.filter((event) => event.type === "KEYFRAME_DECODED").slice(-20);
  const keyframeAfterLoss = primaryLoss
    ? decodedKeyframes.find((event) => event.elapsedMs >= primaryLoss.startedElapsedMs)
    : undefined;
  const transportEvents = {
    ice: events.filter((event) => event.type.includes("ICE_") || event.type === "ICE_STATE_CHANGED").slice(-30).map(compactEvent),
    webSocket: events.filter((event) => event.type.startsWith("GATEWAY_WEBSOCKET_")).slice(-20).map(compactEvent),
    videoTrack: events.filter((event) => event.type.startsWith("MEDIA_TRACK_")).slice(-20).map(compactEvent),
  };
  const cloudMatchEvents = events.filter((event) => event.type.startsWith("CLOUDMATCH_"));
  const remoteProcess = findLast(events, (event) => event.type === "REMOTE_GAME_PROCESS_STATE");
  const recoveryStart = events.find((event) => event.type === "CLOUDMATCH_RECOVERY_STARTED");
  const recoveryFailure = recoveryStart
    ? findLast(events, (event) => event.elapsedMs >= recoveryStart.elapsedMs && event.type === "CLOUDMATCH_RECOVERY_FAILED")
    : undefined;
  const recoverySuccess = recoveryStart
    ? findLast(events, (event) => event.elapsedMs >= recoveryStart.elapsedMs && (
      event.type === "SEAMLESS_RESUME_SUCCEEDED"
    ))
    : undefined;
  const probableProblemCategory = classifyProblem({
    primaryLoss,
    gatewayAtFailure,
    keyframeRequestCount: rollup?.keyframeRequestCount ?? keyframeRequests.length,
    keyframeReceived: Boolean(keyframeAfterLoss),
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    captureStartedAt: stringValue(report.captureStartedAt),
    captureFinishedAt: stringValue(report.captureFinishedAt),
    recoveryProfile: networkProfile(context.resilientNetworkProfile),
    eventRetention: {
      total: rollup?.totalEventCount ?? events.length,
      retained: rollup?.retainedEventCount ?? events.length,
      truncated: rollup?.eventsTruncated ?? false,
    },
    rtpLoss: {
      incidentCount: rollup?.rtpLossIncidentCount ?? rtpLoss.length,
      packetsLostDelta: rollup?.rtpPacketsLostDelta
        ?? rtpLoss.reduce((total, incident) => total + incident.packetsLostDelta, 0),
      incidents: rtpLoss.map(omitElapsed),
      primary: primaryLoss ? omitElapsed(primaryLoss) : null,
    },
    gatewayPingAtFailure: gatewayAtFailure,
    keyframes: {
      requestCount: rollup?.keyframeRequestCount ?? keyframeRequests.length,
      requests: keyframeRequests,
      newKeyframeAfterPrimaryLossAt: keyframeAfterLoss?.timestamp ?? null,
    },
    transportEvents,
    cloudMatch: {
      latest: cloudMatchEvents.length > 0 ? compactEvent(cloudMatchEvents.at(-1)!) : null,
      events: cloudMatchEvents.slice(-20).map(compactEvent),
    },
    remoteGameProcess: remoteProcess ? compactEvent(remoteProcess) : null,
    seamlessResume: {
      attempted: Boolean(recoveryStart),
      profile: recoveryStart?.values?.profile ?? null,
      startedAt: recoveryStart?.timestamp ?? null,
      result: recoveryFailure ? "failed" : recoverySuccess ? "succeeded" : recoveryStart ? "incomplete" : "not_attempted",
      resultAt: recoveryFailure?.timestamp ?? recoverySuccess?.timestamp ?? null,
      detail: recoveryFailure?.detail ?? recoverySuccess?.detail ?? null,
    },
    sessionExit: exit ? {
      at: exit.timestamp,
      reason: exit.detail,
      source: exit.values?.source ?? "unknown",
      reasonCode: exit.values?.reasonCode ?? "unknown",
    } : null,
    probableProblemCategory,
    fullDiagnosticsPath,
  };
}

type RtpLossSummary = {
  startedAt: string;
  startedElapsedMs: number;
  durationMs: number | null;
  packetsLostDelta: number;
  gatewayPingAtStart: { success: boolean; latencyMs: number | null; failure: string } | null;
};

type DiagnosticsRollup = {
  totalEventCount: number;
  retainedEventCount: number;
  eventsTruncated: boolean;
  rtpLossIncidentCount: number;
  rtpPacketsLostDelta: number;
  rtpLoss: RtpLossSummary[];
  keyframeRequestCount: number;
  keyframeRequests: DiagnosticEvent[];
  decodedKeyframes: DiagnosticEvent[];
};

function readDiagnosticsRollup(value: unknown): DiagnosticsRollup | null {
  if (!isJsonObject(value)) return null;
  const rtpLoss = isJsonObject(value.rtpLoss) ? value.rtpLoss : {};
  const keyframes = isJsonObject(value.keyframes) ? value.keyframes : {};
  const incidents = Array.isArray(rtpLoss.incidents)
    ? rtpLoss.incidents.map(readRtpLossIncident).filter((incident): incident is RtpLossSummary => incident !== null)
    : [];
  return {
    totalEventCount: numberValue(value.totalEventCount),
    retainedEventCount: numberValue(value.retainedEventCount),
    eventsTruncated: value.eventsTruncated === true,
    rtpLossIncidentCount: numberValue(rtpLoss.incidentCount),
    rtpPacketsLostDelta: numberValue(rtpLoss.packetsLostDelta),
    rtpLoss: incidents,
    keyframeRequestCount: numberValue(keyframes.requestCount),
    keyframeRequests: readEvents(keyframes.requests),
    decodedKeyframes: readEvents(keyframes.decoded),
  };
}

function readRtpLossIncident(value: unknown): RtpLossSummary | null {
  if (!isJsonObject(value) || typeof value.startedAt !== "string") return null;
  const gateway = isJsonObject(value.gatewayPingAtStart)
    && typeof value.gatewayPingAtStart.success === "boolean"
    ? {
      success: value.gatewayPingAtStart.success,
      latencyMs: nullableLatency(value.gatewayPingAtStart.latencyMs),
      failure: stringValue(value.gatewayPingAtStart.failure) || "unknown",
    }
    : null;
  return {
    startedAt: value.startedAt,
    startedElapsedMs: numberValue(value.startedElapsedMs),
    durationMs: value.durationMs === null ? null : numberValue(value.durationMs),
    packetsLostDelta: numberValue(value.packetsLostDelta),
    gatewayPingAtStart: gateway,
  };
}

function buildRtpLossSummary(events: DiagnosticEvent[]): RtpLossSummary[] {
  const result: RtpLossSummary[] = [];
  let active: RtpLossSummary | null = null;
  for (const event of events) {
    if (event.type === "RTP_LOSS_STARTED") {
      active = {
        startedAt: event.timestamp,
        startedElapsedMs: event.elapsedMs,
        durationMs: null,
        packetsLostDelta: 0,
        gatewayPingAtStart: gatewayFromLossStart(event),
      };
      result.push(active);
    } else if (event.type === "RTP_LOSS_INCREMENT" && active) {
      active.packetsLostDelta += numberValue(event.values?.delta);
    } else if (event.type === "RTP_LOSS_ENDED" && active) {
      active.durationMs = numberValue(event.values?.durationMs);
      active.packetsLostDelta = Math.max(active.packetsLostDelta, numberValue(event.values?.packetsLostDelta));
      active = null;
    }
  }
  return result;
}

function classifyProblem(input: {
  primaryLoss: RtpLossSummary | null;
  gatewayAtFailure: ReturnType<typeof findNearestGateway>;
  keyframeRequestCount: number;
  keyframeReceived: boolean;
}): ProblemCategory {
  const gateway = input.primaryLoss?.gatewayPingAtStart ?? input.gatewayAtFailure;
  if (input.primaryLoss && gateway?.success === false) return "local_network";
  if (input.keyframeRequestCount > 0 && !input.keyframeReceived) return "decoder_or_keyframe";
  if (input.primaryLoss && gateway?.success === true) return "route_or_nvidia";
  return "undetermined";
}

function findNearestGateway(
  events: DiagnosticEvent[],
  targetMs: number,
): { at: string; success: boolean; latencyMs: number | null; failure: string } | null {
  const eligible = events.filter((event) => event.type === "GATEWAY_PING" && (
    !Number.isFinite(targetMs) || Date.parse(event.timestamp) <= targetMs
  ));
  const event = eligible.at(-1);
  if (!event) return null;
  return {
    at: event.timestamp,
    success: event.values?.success === true,
    latencyMs: nullableLatency(event.values?.latencyMs),
    failure: stringValue(event.values?.failure) || "unknown",
  };
}

function gatewayFromLossStart(
  event: DiagnosticEvent,
): { success: boolean; latencyMs: number | null; failure: string } | null {
  if (typeof event.values?.gatewaySuccess !== "boolean") return null;
  return {
    success: event.values.gatewaySuccess,
    latencyMs: nullableLatency(event.values.gatewayLatencyMs),
    failure: event.values.gatewaySuccess ? "none" : "unknown",
  };
}

function appendSessionExit(report: JsonObject, termination: TerminationOverride): JsonObject {
  const now = new Date();
  const captureStartedMs = Date.parse(stringValue(report.captureStartedAt));
  const events = readEvents(report.events);
  if (!events.some((event) => event.type === "SESSION_EXIT")) {
    events.push({
      timestamp: now.toISOString(),
      elapsedMs: Number.isFinite(captureStartedMs) ? Math.max(0, now.getTime() - captureStartedMs) : 0,
      type: "SESSION_EXIT",
      detail: termination.detail,
      values: { source: termination.source, reasonCode: termination.reasonCode },
    });
  }
  return { ...report, captureFinishedAt: now.toISOString(), events };
}

function compactEvent(event: DiagnosticEvent): JsonObject {
  return {
    at: event.timestamp,
    type: event.type,
    detail: event.detail,
    ...(event.values ? { values: event.values } : {}),
  };
}

function omitElapsed(value: RtpLossSummary): Omit<RtpLossSummary, "startedElapsedMs"> {
  const { startedElapsedMs: _startedElapsedMs, ...result } = value;
  return result;
}

function readEvents(value: unknown): DiagnosticEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is JsonObject => (
    isJsonObject(entry)
    && typeof entry.timestamp === "string"
    && typeof entry.elapsedMs === "number"
    && typeof entry.type === "string"
    && typeof entry.detail === "string"
  )).map((entry) => ({
    timestamp: entry.timestamp as string,
    elapsedMs: entry.elapsedMs as number,
    type: entry.type as string,
    detail: entry.detail as string,
    ...(isJsonObject(entry.values) ? { values: entry.values as DiagnosticEvent["values"] } : {}),
  }));
}

function findLast(
  events: DiagnosticEvent[],
  predicate: (event: DiagnosticEvent) => boolean,
): DiagnosticEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (predicate(event)) return event;
  }
  return undefined;
}

function validateReport(value: unknown): JsonObject {
  if (!isJsonObject(value) || !Array.isArray(value.events) || !Array.isArray(value.samples)) {
    throw new Error("Invalid stream diagnostics report");
  }
  JSON.stringify(value);
  return value;
}

function captureIdFor(report: JsonObject): string {
  const captureStartedAt = stringValue(report.captureStartedAt);
  if (!Number.isFinite(Date.parse(captureStartedAt))) {
    throw new Error("Diagnostics report is missing a valid captureStartedAt timestamp");
  }
  return captureStartedAt;
}

function fileTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-|-$/g, "");
}

function networkProfile(value: unknown): NetworkRecoveryProfile | "unknown" {
  return value === "current" || value === "balanced" || value === "survival" ? value : "unknown";
}

function nullableLatency(value: unknown): number | null {
  const number = numberValue(value);
  return number >= 0 ? number : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
