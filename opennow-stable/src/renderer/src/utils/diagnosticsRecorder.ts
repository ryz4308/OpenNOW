import type { GatewayPingResult, NetworkRecoveryProfile } from "@shared/gfn";
import type { StreamDiagnostics } from "../platforms/gfn/webrtcClient";

export interface DiagnosticsRecorderContext {
  gameTitle?: string;
  requestedResolution?: string;
  requestedCodec?: string;
  targetFps?: number;
  requestedMaxBitrateMbps?: number;
  resilientNetworkProfile?: NetworkRecoveryProfile;
}

export interface DiagnosticEvent {
  timestamp: string;
  elapsedMs: number;
  type: string;
  detail: string;
  values?: Record<string, number | string | boolean>;
}

export interface StreamLifecycleDiagnosticEvent {
  type: string;
  detail: string;
  values?: Record<string, number | string | boolean>;
}

type DiagnosticSample = Omit<StreamDiagnostics, "sessionId"> & {
  timestamp: string;
  elapsedMs: number;
  streamIdentifier: string;
};

interface ActiveIncident {
  startedAtMs: number;
  detail: string;
}

const SAMPLE_INTERVAL_MS = 1_000;
const INCIDENT_SAMPLE_INTERVAL_MS = 250;
const INCIDENT_BURST_WINDOW_MS = 10_000;
const MAX_SAMPLES = 3_600;
const MAX_EVENTS = 5_000;
const SPIKE_EVENT_COOLDOWN_MS = 5_000;

export class StreamDiagnosticsRecorder {
  private startedAtMs = Date.now();
  private sessionKey: string | null = null;
  private lastSampleAtMs = Number.NEGATIVE_INFINITY;
  private context: DiagnosticsRecorderContext = {};
  private samples: DiagnosticSample[] = [];
  private events: DiagnosticEvent[] = [];
  private previous: StreamDiagnostics | null = null;
  private readonly incidents = new Map<string, ActiveIncident>();
  private readonly lastSpikeEventAtMs = new Map<string, number>();
  private readonly streamAliases = new Map<string, string>();
  private rtpLossIncident: { startedAtMs: number; initialPacketsLost: number; lastLossAtMs: number } | null = null;
  private rtpLossBurstUntilMs = Number.NEGATIVE_INFINITY;
  private lastGatewayPing: GatewayPingResult | null = null;
  private readonly eventListeners = new Set<(event: DiagnosticEvent) => void>();

  beginSession(
    sessionKey: string,
    context: DiagnosticsRecorderContext,
    startedAtMs = Date.now(),
  ): boolean {
    if (this.sessionKey === sessionKey) {
      this.setContext(context);
      return false;
    }
    this.sessionKey = sessionKey;
    this.startedAtMs = startedAtMs;
    this.lastSampleAtMs = Number.NEGATIVE_INFINITY;
    this.context = { ...context };
    this.samples = [];
    this.events = [];
    this.previous = null;
    this.incidents.clear();
    this.lastSpikeEventAtMs.clear();
    this.streamAliases.clear();
    this.rtpLossIncident = null;
    this.rtpLossBurstUntilMs = Number.NEGATIVE_INFINITY;
    this.lastGatewayPing = null;
    return true;
  }

  subscribeEvents(listener: (event: DiagnosticEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  setContext(context: DiagnosticsRecorderContext): void {
    this.context = { ...this.context, ...context };
  }

  recordEvent(
    event: StreamLifecycleDiagnosticEvent,
    recordedAtMs = Date.now(),
  ): void {
    const type = normalizeEventType(event.type);
    this.pushEvent(
      recordedAtMs,
      type,
      redactDiagnosticDetail(event.detail),
      sanitizeDiagnosticValues(event.values),
    );
  }

  recordGatewayPing(result: GatewayPingResult): void {
    this.lastGatewayPing = result;
    this.pushEvent(
      result.measuredAtMs,
      "GATEWAY_PING",
      result.success ? "Local default gateway replied" : `Local default gateway probe ${result.failure}`,
      {
        success: result.success,
        latencyMs: result.latencyMs ?? -1,
        failure: result.failure,
        rtpLossActive: this.rtpLossIncident !== null,
        incidentBurst: this.isIncidentBurstActive(result.measuredAtMs),
      },
    );
  }

  isIncidentBurstActive(nowMs = Date.now()): boolean {
    return nowMs < this.rtpLossBurstUntilMs;
  }

  record(stats: StreamDiagnostics, recordedAtMs = Date.now()): void {
    this.recordTransitions(stats, recordedAtMs);
    const sampleIntervalMs = this.isIncidentBurstActive(recordedAtMs)
      ? INCIDENT_SAMPLE_INTERVAL_MS
      : SAMPLE_INTERVAL_MS;
    if (recordedAtMs - this.lastSampleAtMs < sampleIntervalMs) {
      this.previous = cloneDiagnostics(stats);
      return;
    }

    this.lastSampleAtMs = recordedAtMs;
    const { sessionId, ...safeStats } = cloneDiagnostics(stats);
    this.samples.push({
      timestamp: new Date(recordedAtMs).toISOString(),
      elapsedMs: Math.max(0, recordedAtMs - this.startedAtMs),
      streamIdentifier: this.aliasForSession(sessionId),
      ...safeStats,
    });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.previous = cloneDiagnostics(stats);
  }

  exportReport(generatedAtMs = Date.now()): Record<string, unknown> {
    const finishedAt = this.samples.at(-1)?.timestamp ?? new Date(generatedAtMs).toISOString();
    return {
      schemaVersion: 6,
      generatedAt: new Date(generatedAtMs).toISOString(),
      captureStartedAt: new Date(this.startedAtMs).toISOString(),
      captureFinishedAt: finishedAt,
      context: this.context,
      notes: [
        "Samples are captured once per second, increasing to four per second for ten seconds around RTP loss.",
        "GATEWAY_PING is measured against the local default gateway; its address is never exported.",
        "streamIdentifier is a local alias; the NVIDIA session identifier is not exported.",
        "availableBitrateKbps is browser-estimated and may be unavailable or inaccurate.",
        "Cursor Viewport Guard events record CSS viewport, source resolution, and DPI resynchronization.",
        "Gateway, CloudMatch, ICE, RTP, bitrate, keyframe, track, and exit lifecycle events are sanitized before export.",
        "NETWORK_STALL and RENDER_STALL are diagnostic classifications, not proof of a single root cause.",
      ],
      summary: this.buildSummary(),
      activeIncidents: [...this.incidents.entries()].map(([type, incident]) => ({
        type,
        startedAt: new Date(incident.startedAtMs).toISOString(),
        durationMs: Math.max(0, generatedAtMs - incident.startedAtMs),
        detail: incident.detail,
      })),
      events: this.events,
      samples: this.samples,
    };
  }

  private recordTransitions(stats: StreamDiagnostics, nowMs: number): void {
    const previous = this.previous;
    if (!previous) {
      this.pushEvent(nowMs, "CAPTURE_STARTED", "First stream diagnostics received");
    } else {
      this.recordChangedValue(nowMs, "CONNECTION_STATE_CHANGED", "connection", previous.connectionState, stats.connectionState);
      this.recordChangedValue(nowMs, "ICE_STATE_CHANGED", "ICE", previous.iceConnectionState, stats.iceConnectionState);
      this.recordChangedValue(nowMs, "SIGNALING_STATE_CHANGED", "signaling", previous.signalingState, stats.signalingState);
      this.recordChangedValue(nowMs, "TRANSPORT_CHANGED", "transport", previous.transportType, stats.transportType);
      this.recordChangedValue(nowMs, "RESOLUTION_CHANGED", "resolution", previous.resolution, stats.resolution);
      this.recordChangedValue(nowMs, "CODEC_CHANGED", "codec", previous.codec, stats.codec);
      this.recordNumericChange(
        nowMs,
        "BITRATE_TARGET_CHANGED",
        "targetBitrateKbps",
        previous.targetBitrateKbps,
        stats.targetBitrateKbps,
      );
      this.recordAvailableBitrateTransition(nowMs, previous, stats);
      this.recordRecoveryActionChange(nowMs, "NETWORK_RECOVERY_ACTION", previous.networkRecoveryAction, stats.networkRecoveryAction);
      this.recordRecoveryActionChange(nowMs, "DECODER_RECOVERY_ACTION", previous.decoderRecoveryAction, stats.decoderRecoveryAction);
      if (
        stats.framesReceived < previous.framesReceived
        || stats.packetsReceived < previous.packetsReceived
        || stats.keyFramesDecoded < previous.keyFramesDecoded
      ) {
        this.pushEvent(nowMs, "RTP_COUNTER_RESET", "Inbound RTP counters reset after a stream or receiver change", {
          framesReceived: stats.framesReceived,
          packetsReceived: stats.packetsReceived,
          keyFramesDecoded: stats.keyFramesDecoded,
        });
      }
      if (previous.sessionId !== stats.sessionId && stats.sessionId) {
        this.pushEvent(nowMs, "STREAM_CHANGED", `Active stream is ${this.aliasForSession(stats.sessionId)}`);
      }
      if (previous.dataChannels.join("|") !== stats.dataChannels.join("|")) {
        this.pushEvent(nowMs, "DATA_CHANNELS_CHANGED", stats.dataChannels.join(", ") || "No reported data channels");
      }
      if (stats.freezeCount > previous.freezeCount || stats.totalFreezesDurationMs > previous.totalFreezesDurationMs) {
        this.pushEvent(nowMs, "WEBRTC_FREEZE_REPORTED", "Browser inbound-video freeze counters increased", {
          freezeCount: stats.freezeCount,
          totalFreezesDurationMs: stats.totalFreezesDurationMs,
        });
      }
      if (stats.cursorViewportResyncCount > previous.cursorViewportResyncCount) {
        this.pushEvent(nowMs, "CURSOR_VIEWPORT_RESYNC", stats.cursorViewportLastResyncReason, {
          viewportWidth: round(stats.cursorViewportWidth, 1),
          viewportHeight: round(stats.cursorViewportHeight, 1),
          videoRectWidth: round(stats.cursorVideoRectWidth, 1),
          videoRectHeight: round(stats.cursorVideoRectHeight, 1),
          sourceWidth: stats.cursorSourceWidth,
          sourceHeight: stats.cursorSourceHeight,
          devicePixelRatio: round(stats.cursorDevicePixelRatio, 2),
          pointerLocked: stats.cursorPointerLocked,
        });
      }
      this.recordCounterIncrease(nowMs, "KEYFRAME_DECODED", "keyFramesDecoded", previous.keyFramesDecoded, stats.keyFramesDecoded);
      this.recordCounterIncrease(nowMs, "NACK_INCREASED", "nackCount", previous.nackCount, stats.nackCount);
      this.recordCounterIncrease(nowMs, "PLI_INCREASED", "pliCount", previous.pliCount, stats.pliCount);
      this.recordCounterIncrease(nowMs, "FIR_INCREASED", "firCount", previous.firCount, stats.firCount);
      this.recordRtpLoss(nowMs, previous, stats);
    }

    const targetFps = Math.max(30, this.context.targetFps ?? 60);
    const networkDegraded = stats.packetLossPercent >= 1 || stats.rttMs >= 100 || stats.jitterMs >= 20;
    const networkStall = networkDegraded && (
      (stats.receiveFps > 0 && stats.receiveFps < targetFps * 0.75)
      || stats.lagReason === "network"
    );
    const renderStall = stats.decodeFps >= targetFps * 0.75
      && stats.renderFps > 0
      && stats.renderFps < stats.decodeFps * 0.75;

    this.updateIncident("NETWORK_STALL", networkStall, nowMs, stats.lagReasonDetail, stats);
    this.updateIncident("RENDER_STALL", renderStall, nowMs, stats.lagReasonDetail, stats);

    if (stats.packetLossPercent >= 1) {
      this.pushSpikeEvent(nowMs, "PACKET_LOSS_SPIKE", `${stats.packetLossPercent.toFixed(2)}% packet loss`, {
        packetLossPercent: round(stats.packetLossPercent, 3),
        receiveFps: stats.receiveFps,
        renderFps: stats.renderFps,
      });
    }
    if (stats.rttMs >= 100) {
      this.pushSpikeEvent(nowMs, "RTT_SPIKE", `${stats.rttMs.toFixed(1)} ms RTT`, {
        rttMs: round(stats.rttMs, 1),
        jitterMs: round(stats.jitterMs, 1),
      });
    }
  }

  private recordRtpLoss(
    nowMs: number,
    previous: StreamDiagnostics,
    current: StreamDiagnostics,
  ): void {
    const delta = current.packetsLost - previous.packetsLost;
    if (delta > 0) {
      this.rtpLossBurstUntilMs = Math.max(this.rtpLossBurstUntilMs, nowMs + INCIDENT_BURST_WINDOW_MS);
      if (!this.rtpLossIncident) {
        this.rtpLossIncident = {
          startedAtMs: nowMs,
          initialPacketsLost: previous.packetsLost,
          lastLossAtMs: nowMs,
        };
        this.pushEvent(nowMs, "RTP_LOSS_STARTED", "Inbound RTP packet loss started", {
          packetsLost: current.packetsLost,
          packetsLostDelta: delta,
          bitrateKbps: current.bitrateKbps,
          availableBitrateKbps: current.availableBitrateKbps,
          gatewaySuccess: this.lastGatewayPing?.success ?? false,
          gatewayLatencyMs: this.lastGatewayPing?.latencyMs ?? -1,
        });
      } else {
        this.rtpLossIncident.lastLossAtMs = nowMs;
      }
      this.pushEvent(nowMs, "RTP_LOSS_INCREMENT", `packetsLost increased by ${delta}`, {
        previous: previous.packetsLost,
        current: current.packetsLost,
        delta,
        bitrateKbps: current.bitrateKbps,
        receiveFps: current.receiveFps,
      });
      return;
    }

    if (this.rtpLossIncident && delta === 0) {
      const incident = this.rtpLossIncident;
      this.rtpLossIncident = null;
      this.pushEvent(nowMs, "RTP_LOSS_ENDED", "Inbound RTP packet loss stopped increasing", {
        durationMs: Math.max(0, nowMs - incident.startedAtMs),
        quietAfterLastLossMs: Math.max(0, nowMs - incident.lastLossAtMs),
        packetsLostDelta: Math.max(0, current.packetsLost - incident.initialPacketsLost),
      });
    }
  }

  private updateIncident(
    type: "NETWORK_STALL" | "RENDER_STALL",
    active: boolean,
    nowMs: number,
    detail: string,
    stats: StreamDiagnostics,
  ): void {
    const current = this.incidents.get(type);
    if (active && !current) {
      this.incidents.set(type, { startedAtMs: nowMs, detail });
      this.pushEvent(nowMs, type, detail, diagnosticValues(stats));
    } else if (!active && current) {
      this.incidents.delete(type);
      this.pushEvent(nowMs, "RECOVERY_NOTICED", `${type} ended`, {
        incident: type,
        durationMs: Math.max(0, nowMs - current.startedAtMs),
      });
    }
  }

  private recordChangedValue(
    nowMs: number,
    eventType: string,
    label: string,
    previous: string,
    current: string,
  ): void {
    if (previous === current || (!previous && !current)) return;
    this.pushEvent(nowMs, eventType, `${label}: ${previous || "none"} -> ${current || "none"}`);
  }

  private recordCounterIncrease(
    nowMs: number,
    eventType: string,
    counter: string,
    previous: number,
    current: number,
  ): void {
    if (current <= previous) return;
    this.pushEvent(nowMs, eventType, `${counter} increased by ${current - previous}`, {
      previous,
      current,
      delta: current - previous,
    });
  }

  private recordNumericChange(
    nowMs: number,
    eventType: string,
    counter: string,
    previous: number,
    current: number,
  ): void {
    if (previous === current || (!previous && !current)) return;
    this.pushEvent(nowMs, eventType, `${counter}: ${previous} -> ${current}`, {
      previous,
      current,
    });
  }

  private recordAvailableBitrateTransition(
    nowMs: number,
    previous: StreamDiagnostics,
    current: StreamDiagnostics,
  ): void {
    const target = Math.max(current.targetBitrateKbps, this.context.requestedMaxBitrateMbps
      ? this.context.requestedMaxBitrateMbps * 1_000
      : 0);
    if (target <= 0 || current.availableBitrateKbps <= 0) return;
    const previousRatio = previous.availableBitrateKbps > 0
      ? previous.availableBitrateKbps / target
      : 1;
    const currentRatio = current.availableBitrateKbps / target;
    if (previousRatio >= 0.5 && currentRatio < 0.5) {
      this.pushEvent(nowMs, "AVAILABLE_BITRATE_COLLAPSE", "Browser-estimated incoming bitrate fell below 50% of target", {
        availableBitrateKbps: current.availableBitrateKbps,
        targetBitrateKbps: target,
      });
    } else if (previousRatio < 0.5 && currentRatio >= 0.75) {
      this.pushEvent(nowMs, "AVAILABLE_BITRATE_RECOVERED", "Browser-estimated incoming bitrate recovered above 75% of target", {
        availableBitrateKbps: current.availableBitrateKbps,
        targetBitrateKbps: target,
      });
    }
  }

  private recordRecoveryActionChange(
    nowMs: number,
    eventType: string,
    previous: string,
    current: string,
  ): void {
    if (previous === current || current === "none") return;
    this.pushEvent(nowMs, eventType, current.replaceAll("_", " "), { action: current });
  }

  private pushSpikeEvent(
    nowMs: number,
    type: string,
    detail: string,
    values: Record<string, number | string | boolean>,
  ): void {
    const lastAt = this.lastSpikeEventAtMs.get(type) ?? Number.NEGATIVE_INFINITY;
    if (nowMs - lastAt < SPIKE_EVENT_COOLDOWN_MS) return;
    this.lastSpikeEventAtMs.set(type, nowMs);
    this.pushEvent(nowMs, type, detail, values);
  }

  private pushEvent(
    nowMs: number,
    type: string,
    detail: string,
    values?: Record<string, number | string | boolean>,
  ): void {
    const event = {
      timestamp: new Date(nowMs).toISOString(),
      elapsedMs: Math.max(0, nowMs - this.startedAtMs),
      type,
      detail,
      values,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const listener of this.eventListeners) listener(event);
  }

  private aliasForSession(sessionId: string): string {
    if (!sessionId) return "none";
    const existing = this.streamAliases.get(sessionId);
    if (existing) return existing;
    const alias = `stream-${this.streamAliases.size + 1}`;
    this.streamAliases.set(sessionId, alias);
    return alias;
  }

  private buildSummary(): Record<string, unknown> {
    const metrics = {
      packetLossPercent: this.samples.map((sample) => sample.packetLossPercent),
      rttMs: this.samples.map((sample) => sample.rttMs),
      jitterMs: this.samples.map((sample) => sample.jitterMs),
      bitrateKbps: this.samples.map((sample) => sample.bitrateKbps),
      receiveFps: this.samples.map((sample) => sample.receiveFps),
      decodeFps: this.samples.map((sample) => sample.decodeFps),
      renderFps: this.samples.map((sample) => sample.renderFps),
      decodeTimeMs: this.samples.map((sample) => sample.decodeTimeMs),
      jitterBufferDelayMs: this.samples.map((sample) => sample.jitterBufferDelayMs),
    };
    return {
      sampleCount: this.samples.length,
      eventCount: this.events.length,
      durationSeconds: this.samples.length > 1
        ? Math.round((Date.parse(this.samples.at(-1)!.timestamp) - Date.parse(this.samples[0]!.timestamp)) / 1000)
        : 0,
      incidents: countEvents(this.events, ["NETWORK_STALL", "RENDER_STALL", "WEBRTC_FREEZE_REPORTED"]),
      recoveries: this.events.filter((event) => event.type === "RECOVERY_NOTICED").length,
      metrics: Object.fromEntries(Object.entries(metrics).map(([name, values]) => [name, summarize(values)])),
      finalCounters: this.samples.length > 0 ? {
        framesReceived: this.samples.at(-1)!.framesReceived,
        framesDecoded: this.samples.at(-1)!.framesDecoded,
        framesDropped: this.samples.at(-1)!.framesDropped,
        keyFramesDecoded: this.samples.at(-1)!.keyFramesDecoded,
        nackCount: this.samples.at(-1)!.nackCount,
        pliCount: this.samples.at(-1)!.pliCount,
        firCount: this.samples.at(-1)!.firCount,
        freezeCount: this.samples.at(-1)!.freezeCount,
        totalFreezesDurationMs: this.samples.at(-1)!.totalFreezesDurationMs,
      } : null,
    };
  }
}

function diagnosticValues(stats: StreamDiagnostics): Record<string, number | string | boolean> {
  return {
    packetLossPercent: round(stats.packetLossPercent, 3),
    rttMs: round(stats.rttMs, 1),
    jitterMs: round(stats.jitterMs, 1),
    receiveFps: stats.receiveFps,
    decodeFps: stats.decodeFps,
    renderFps: stats.renderFps,
    bitrateKbps: stats.bitrateKbps,
    resolution: stats.resolution,
    lagReason: stats.lagReason,
  };
}

function cloneDiagnostics(stats: StreamDiagnostics): StreamDiagnostics {
  return { ...stats, dataChannels: [...stats.dataChannels] };
}

function countEvents(events: DiagnosticEvent[], types: string[]): Record<string, number> {
  return Object.fromEntries(types.map((type) => [type, events.filter((event) => event.type === type).length]));
}

function summarize(values: number[]): Record<string, number | null> {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return { min: null, average: null, p95: null, max: null };
  const average = finite.reduce((total, value) => total + value, 0) / finite.length;
  return {
    min: round(finite[0]!, 2),
    average: round(average, 2),
    p95: round(finite[Math.min(finite.length - 1, Math.floor(finite.length * 0.95))]!, 2),
    max: round(finite.at(-1)!, 2),
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const SENSITIVE_VALUE_KEY = /(^candidate$|credential|deviceId|hostAddress|(^|_)id$|(^|_)ip$|peerId|serverAddress|sessionId|token|url)/i;

function normalizeEventType(type: string): string {
  const normalized = type.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
  return normalized.slice(0, 80) || "DIAGNOSTIC_EVENT";
}

function redactDiagnosticDetail(detail: string): string {
  return detail
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .slice(0, 500);
}

function sanitizeDiagnosticValues(
  values?: Record<string, number | string | boolean>,
): Record<string, number | string | boolean> | undefined {
  if (!values) return undefined;
  const safe = Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => !SENSITIVE_VALUE_KEY.test(key))
      .slice(0, 32)
      .map(([key, value]) => [key, typeof value === "string" ? redactDiagnosticDetail(value) : value]),
  );
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export const streamDiagnosticsRecorder = new StreamDiagnosticsRecorder();
