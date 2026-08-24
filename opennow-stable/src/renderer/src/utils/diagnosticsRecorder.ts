import type { StreamDiagnostics } from "../platforms/gfn/webrtcClient";

export interface DiagnosticsRecorderContext {
  gameTitle?: string;
  requestedResolution?: string;
  requestedCodec?: string;
  targetFps?: number;
  requestedMaxBitrateMbps?: number;
  resilientNetworkProfile?: boolean;
  absolutePointerCoordinateGuard?: boolean;
  compositorSafeMode?: boolean;
  smoothPlaybackBuffer?: boolean;
}

export interface DiagnosticEvent {
  timestamp: string;
  elapsedMs: number;
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
const MAX_SAMPLES = 3_600;
const MAX_EVENTS = 2_000;
const SPIKE_EVENT_COOLDOWN_MS = 5_000;

export class StreamDiagnosticsRecorder {
  private readonly startedAtMs = Date.now();
  private lastSampleAtMs = Number.NEGATIVE_INFINITY;
  private context: DiagnosticsRecorderContext = {};
  private samples: DiagnosticSample[] = [];
  private events: DiagnosticEvent[] = [];
  private previous: StreamDiagnostics | null = null;
  private readonly incidents = new Map<string, ActiveIncident>();
  private readonly lastSpikeEventAtMs = new Map<string, number>();
  private readonly streamAliases = new Map<string, string>();

  setContext(context: DiagnosticsRecorderContext): void {
    this.context = { ...this.context, ...context };
  }

  record(stats: StreamDiagnostics, recordedAtMs = Date.now()): void {
    this.recordTransitions(stats, recordedAtMs);
    if (recordedAtMs - this.lastSampleAtMs < SAMPLE_INTERVAL_MS) {
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
        "Samples are captured once per second even when the statistics overlay is closed.",
        "streamIdentifier is a local alias; the NVIDIA session identifier is not exported.",
        "availableBitrateKbps is browser-estimated and may be unavailable or inaccurate.",
        "Cursor Viewport Guard events record CSS viewport, source resolution, and DPI resynchronization.",
        "Absolute pointer mapping uses the requested logical desktop; adaptive video resolution is reported separately.",
        "jitterBufferCurrentDelayMs is an interval value; jitterBufferDelayMs is the cumulative session average.",
        "Playback-frame drops and renderer stalls are local presentation signals and can occur with a healthy decoder/network.",
        "STATS_POLL_STALL marks delayed diagnostics sampling and is a useful proxy for a blocked renderer/main thread, not a network-loss counter.",
        "Resilient Network Profile describes the negotiated startup profile; recoveryAttempts only counts runtime recovery actions.",
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
      if (
        stats.cursorPointerLocked !== previous.cursorPointerLocked
        || stats.pointerLockLossCount !== previous.pointerLockLossCount
        || stats.pointerRelockAttemptCount !== previous.pointerRelockAttemptCount
      ) {
        this.pushEvent(nowMs, "POINTER_LOCK_CHANGED", stats.pointerLockLastChangeReason, {
          pointerLocked: stats.cursorPointerLocked,
          lossCount: stats.pointerLockLossCount,
          relockAttempts: stats.pointerRelockAttemptCount,
          relockSuccesses: stats.pointerRelockSuccessCount,
          relockFailures: stats.pointerRelockFailureCount,
          escapeFallbackActive: stats.pointerEscapeFallbackActive,
          documentHasFocus: stats.documentHasFocus,
          visibility: stats.documentVisibilityState,
          fullscreen: stats.documentFullscreenActive,
          sidebarOpen: stats.streamSidebarOpen,
        });
      }
      if (stats.absolutePointerMappingRevision !== previous.absolutePointerMappingRevision) {
        this.pushEvent(nowMs, "ABSOLUTE_POINTER_MAPPING_CHANGED", "Absolute pointer coordinate space changed", {
          enabled: stats.absolutePointerGuardEnabled,
          localWidth: round(stats.absolutePointerLocalWidth, 1),
          localHeight: round(stats.absolutePointerLocalHeight, 1),
          logicalWidth: round(stats.absolutePointerLogicalWidth, 1),
          logicalHeight: round(stats.absolutePointerLogicalHeight, 1),
          lastX: round(stats.absolutePointerLastX, 1),
          lastY: round(stats.absolutePointerLastY, 1),
        });
      }
      this.recordChangedBoolean(nowMs, "COMPOSITOR_SAFE_MODE_CHANGED", "compositor safe mode", previous.compositorSafeModeEnabled, stats.compositorSafeModeEnabled);
      this.recordChangedBoolean(nowMs, "SMOOTH_BUFFER_CHANGED", "smooth playback buffer", previous.smoothPlaybackBufferEnabled, stats.smoothPlaybackBufferEnabled);
      if (stats.smoothPlaybackAppliedCount > previous.smoothPlaybackAppliedCount) {
        this.pushEvent(nowMs, "SMOOTH_BUFFER_APPLIED", "Receiver playout targets applied", {
          appliedCount: stats.smoothPlaybackAppliedCount,
          videoTargetMs: stats.smoothPlaybackVideoTargetMs,
          audioTargetMs: stats.smoothPlaybackAudioTargetMs,
          jitterBufferTargetSupported: stats.smoothPlaybackJitterBufferTargetSupported,
          playoutDelayHintSupported: stats.smoothPlaybackPlayoutDelayHintSupported,
        });
      }
      if (stats.videoPlaybackDroppedFrames > previous.videoPlaybackDroppedFrames) {
        this.pushSpikeEvent(nowMs, "VIDEO_PRESENTATION_DROP_SPIKE", "Chromium video presentation dropped frames", {
          droppedDelta: stats.videoPlaybackDroppedFrames - previous.videoPlaybackDroppedFrames,
          droppedTotal: stats.videoPlaybackDroppedFrames,
          playbackTotal: stats.videoPlaybackTotalFrames,
          decodeFps: stats.decodeFps,
          renderFps: stats.renderFps,
        });
      }
      this.recordCounterIncrease(nowMs, "KEYFRAME_DECODED", "keyFramesDecoded", previous.keyFramesDecoded, stats.keyFramesDecoded);
      this.recordCounterIncrease(nowMs, "NACK_INCREASED", "nackCount", previous.nackCount, stats.nackCount);
      this.recordCounterIncrease(nowMs, "PLI_INCREASED", "pliCount", previous.pliCount, stats.pliCount);
      this.recordCounterIncrease(nowMs, "FIR_INCREASED", "firCount", previous.firCount, stats.firCount);
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
    if (stats.statsPollIntervalMs >= 1_500 || stats.statsCollectionDurationMs >= 250) {
      this.pushSpikeEvent(nowMs, "STATS_POLL_STALL", "WebRTC statistics sampling was delayed", {
        pollIntervalMs: round(stats.statsPollIntervalMs, 1),
        collectionDurationMs: round(stats.statsCollectionDurationMs, 1),
        packetLossPercent: round(stats.packetLossPercent, 3),
        decodeFps: stats.decodeFps,
        renderFps: stats.renderFps,
        documentHasFocus: stats.documentHasFocus,
        visibility: stats.documentVisibilityState,
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

  private recordChangedBoolean(
    nowMs: number,
    eventType: string,
    label: string,
    previous: boolean,
    current: boolean,
  ): void {
    if (previous === current) return;
    this.pushEvent(nowMs, eventType, `${label}: ${previous ? "on" : "off"} -> ${current ? "on" : "off"}`);
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
    this.events.push({
      timestamp: new Date(nowMs).toISOString(),
      elapsedMs: Math.max(0, nowMs - this.startedAtMs),
      type,
      detail,
      values,
    });
    if (this.events.length > MAX_EVENTS) this.events.shift();
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
      jitterBufferCurrentDelayMs: this.samples.map((sample) => sample.jitterBufferCurrentDelayMs),
      videoPlaybackDroppedFrames: this.samples.map((sample) => sample.videoPlaybackDroppedFrames),
      pointerLockLossCount: this.samples.map((sample) => sample.pointerLockLossCount),
      statsPollIntervalMs: this.samples.map((sample) => sample.statsPollIntervalMs),
      statsCollectionDurationMs: this.samples.map((sample) => sample.statsCollectionDurationMs),
      averageProcessingDelayMs: this.samples.map((sample) => sample.averageProcessingDelayMs),
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
        videoPlaybackDroppedFrames: this.samples.at(-1)!.videoPlaybackDroppedFrames,
        pointerLockLossCount: this.samples.at(-1)!.pointerLockLossCount,
        pointerRelockAttemptCount: this.samples.at(-1)!.pointerRelockAttemptCount,
        pointerRelockSuccessCount: this.samples.at(-1)!.pointerRelockSuccessCount,
        pointerRelockFailureCount: this.samples.at(-1)!.pointerRelockFailureCount,
        retransmittedPacketsReceived: this.samples.at(-1)!.retransmittedPacketsReceived,
        fecPacketsReceived: this.samples.at(-1)!.fecPacketsReceived,
        fecPacketsDiscarded: this.samples.at(-1)!.fecPacketsDiscarded,
        packetsDiscarded: this.samples.at(-1)!.packetsDiscarded,
      } : null,
    };
  }
}

function diagnosticValues(stats: StreamDiagnostics): Record<string, number | string | boolean> {
  return {
    packetLossPercent: round(stats.packetLossPercent, 3),
    rttMs: round(stats.rttMs, 1),
    jitterMs: round(stats.jitterMs, 1),
    jitterBufferCurrentDelayMs: round(stats.jitterBufferCurrentDelayMs, 1),
    receiveFps: stats.receiveFps,
    decodeFps: stats.decodeFps,
    renderFps: stats.renderFps,
    bitrateKbps: stats.bitrateKbps,
    resolution: stats.resolution,
    lagReason: stats.lagReason,
    videoPlaybackDroppedFrames: stats.videoPlaybackDroppedFrames,
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

export const streamDiagnosticsRecorder = new StreamDiagnosticsRecorder();
