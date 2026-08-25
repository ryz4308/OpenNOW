import test from "node:test";
import assert from "node:assert/strict";

import { defaultDiagnostics } from "../lib/streamDiagnostics";
import { StreamDiagnosticsRecorder } from "./diagnosticsRecorder";

test("records network and renderer incidents without exposing the raw session id", () => {
  const recorder = new StreamDiagnosticsRecorder();
  const startedAt = Date.now();
  recorder.setContext({
    gameTitle: "Test Game",
    targetFps: 60,
    requestedMaxBitrateMbps: 20,
    resilientNetworkProfile: "balanced",
  });

  recorder.record({
    ...defaultDiagnostics(),
    connectionState: "connected",
    iceConnectionState: "connected",
    signalingState: "stable",
    sessionId: "secret-session-id",
    receiveFps: 60,
    decodeFps: 60,
    renderFps: 60,
    dataChannels: ["control", "input"],
    targetBitrateKbps: 20_000,
    availableBitrateKbps: 18_000,
    framesReceived: 100,
    packetsReceived: 1_000,
    keyFramesDecoded: 2,
  }, startedAt);
  recorder.recordEvent({
    type: "gateway websocket connected",
    detail: "Connected through https://gateway.example.test/path at 192.0.2.10",
    values: {
      sessionId: "secret-session-id",
      candidateType: "srflx",
      protocol: "udp",
    },
  }, startedAt + 100);
  recorder.record({
    ...defaultDiagnostics(),
    connectionState: "connected",
    iceConnectionState: "connected",
    signalingState: "stable",
    sessionId: "secret-session-id",
    receiveFps: 20,
    decodeFps: 20,
    renderFps: 20,
    packetLossPercent: 12.5,
    rttMs: 180,
    jitterMs: 24,
    lagReason: "network",
    lagReasonDetail: "network loss burst",
    nackCount: 8,
    pliCount: 1,
    dataChannels: ["control", "input"],
    cursorViewportResyncCount: 1,
    cursorViewportLastResyncReason: "fullscreen-change-settled",
    cursorViewportWidth: 1920,
    cursorViewportHeight: 1080,
    cursorVideoRectWidth: 1920,
    cursorVideoRectHeight: 1080,
    cursorSourceWidth: 1280,
    cursorSourceHeight: 720,
    cursorDevicePixelRatio: 1,
    cursorPointerLocked: true,
    targetBitrateKbps: 12_000,
    availableBitrateKbps: 4_000,
    framesReceived: 120,
    packetsReceived: 1_100,
    keyFramesDecoded: 3,
    networkRecoveryAction: "keyframe_requested",
  }, startedAt + 1_100);
  recorder.record({
    ...defaultDiagnostics(),
    connectionState: "connected",
    iceConnectionState: "connected",
    signalingState: "stable",
    sessionId: "secret-session-id",
    receiveFps: 60,
    decodeFps: 60,
    renderFps: 30,
    lagReason: "render",
    lagReasonDetail: "renderer fell behind decoded frames",
    nackCount: 8,
    pliCount: 1,
    dataChannels: ["control", "input"],
    targetBitrateKbps: 12_000,
    availableBitrateKbps: 16_000,
    framesReceived: 5,
    packetsReceived: 20,
    keyFramesDecoded: 1,
  }, startedAt + 2_200);
  recorder.record({
    ...defaultDiagnostics(),
    connectionState: "connected",
    iceConnectionState: "connected",
    signalingState: "stable",
    sessionId: "secret-session-id",
    receiveFps: 60,
    decodeFps: 60,
    renderFps: 60,
    nackCount: 8,
    pliCount: 1,
    dataChannels: ["control", "input"],
    targetBitrateKbps: 12_000,
    availableBitrateKbps: 10_000,
    framesReceived: 65,
    packetsReceived: 620,
    keyFramesDecoded: 2,
  }, startedAt + 3_300);

  const report = recorder.exportReport(startedAt + 3_300);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("secret-session-id"), false);
  assert.equal(serialized.includes("gateway.example.test"), false);
  assert.equal(serialized.includes("192.0.2.10"), false);
  assert.equal(serialized.includes("stream-1"), true);

  const events = report.events as Array<{ type: string; values?: Record<string, unknown> }>;
  assert.equal(events.some((event) => event.type === "NETWORK_STALL"), true);
  assert.equal(events.some((event) => event.type === "RENDER_STALL"), true);
  assert.equal(events.filter((event) => event.type === "RECOVERY_NOTICED").length, 2);
  assert.equal(events.some((event) => event.type === "NACK_INCREASED"), true);
  assert.equal(events.some((event) => event.type === "PLI_INCREASED"), true);
  assert.equal(events.some((event) => event.type === "CURSOR_VIEWPORT_RESYNC"), true);
  assert.equal(events.some((event) => event.type === "GATEWAY_WEBSOCKET_CONNECTED"), true);
  assert.equal(events.some((event) => event.type === "BITRATE_TARGET_CHANGED"), true);
  assert.equal(events.some((event) => event.type === "AVAILABLE_BITRATE_COLLAPSE"), true);
  assert.equal(events.some((event) => event.type === "AVAILABLE_BITRATE_RECOVERED"), true);
  assert.equal(events.some((event) => event.type === "NETWORK_RECOVERY_ACTION"), true);
  assert.equal(events.some((event) => event.type === "RTP_COUNTER_RESET"), true);
  const gatewayEvent = events.find((event) => event.type === "GATEWAY_WEBSOCKET_CONNECTED");
  assert.deepEqual(gatewayEvent?.values, { candidateType: "srflx", protocol: "udp" });
  assert.equal(report.schemaVersion, 5);

  const summary = report.summary as {
    sampleCount: number;
    incidents: Record<string, number>;
    recoveries: number;
  };
  assert.equal(summary.sampleCount, 4);
  assert.equal(summary.incidents.NETWORK_STALL, 1);
  assert.equal(summary.incidents.RENDER_STALL, 1);
  assert.equal(summary.recoveries, 2);
});
