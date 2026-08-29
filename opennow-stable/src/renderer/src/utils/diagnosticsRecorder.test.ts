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
    packetsLost: 2,
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
  recorder.recordGatewayPing({
    measuredAtMs: startedAt + 1_050,
    success: true,
    latencyMs: 2,
    failure: "none",
  });
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
    packetsLost: 7,
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
    packetsLost: 7,
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
  assert.equal(events.some((event) => event.type === "RTP_LOSS_STARTED"), true);
  assert.equal(events.some((event) => event.type === "RTP_LOSS_INCREMENT"), true);
  assert.equal(events.some((event) => event.type === "RTP_LOSS_ENDED"), true);
  assert.equal(events.some((event) => event.type === "GATEWAY_PING"), true);
  const gatewayEvent = events.find((event) => event.type === "GATEWAY_WEBSOCKET_CONNECTED");
  assert.deepEqual(gatewayEvent?.values, { candidateType: "srflx", protocol: "udp" });
  assert.equal(report.schemaVersion, 8);

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

test("starts a fresh report for a new remote session and exposes SESSION_EXIT to persistence", () => {
  const recorder = new StreamDiagnosticsRecorder();
  const exits: string[] = [];
  const unsubscribe = recorder.subscribeEvents((event) => {
    if (event.type === "SESSION_EXIT") exits.push(event.detail);
  });

  assert.equal(recorder.beginSession("first-secret-id", {
    resilientNetworkProfile: "balanced",
  }, Date.parse("2026-08-28T12:00:00.000Z")), true);
  recorder.record({ ...defaultDiagnostics(), sessionId: "first-secret-id" }, Date.parse("2026-08-28T12:00:01.000Z"));
  assert.equal(recorder.beginSession("first-secret-id", {
    resilientNetworkProfile: "survival",
  }, Date.parse("2026-08-28T12:00:02.000Z")), false);
  recorder.recordEvent({
    type: "session exit",
    detail: "exact transport failure",
    values: { reasonCode: "transport_failed" },
  }, Date.parse("2026-08-28T12:00:03.000Z"));

  const report = recorder.exportReport(Date.parse("2026-08-28T12:00:03.000Z")) as any;
  assert.equal(report.context.resilientNetworkProfile, "survival");
  assert.deepEqual(exits, ["exact transport failure"]);
  assert.equal(JSON.stringify(report).includes("first-secret-id"), false);
  unsubscribe();
});

test("checkpoint reports stay bounded while completed reports retain the full session", () => {
  const recorder = new StreamDiagnosticsRecorder();
  const startedAt = Date.parse("2026-08-28T12:00:00.000Z");
  recorder.beginSession("bounded-checkpoint", { resilientNetworkProfile: "current" }, startedAt);

  for (let index = 0; index < 500; index += 1) {
    recorder.recordEvent({ type: "diagnostic event", detail: `event ${index}` }, startedAt + index * 1_000);
    recorder.record({
      ...defaultDiagnostics(),
      sessionId: "bounded-checkpoint",
      packetsReceived: index * 100,
      framesReceived: index * 60,
      framesDecoded: index * 60,
    }, startedAt + index * 1_000);
  }

  const checkpoint = recorder.exportCheckpointReport(startedAt + 500_000) as any;
  const completed = recorder.exportReport(startedAt + 500_000) as any;
  assert.equal(checkpoint.checkpoint, true);
  assert.equal(checkpoint.samples.length, 120);
  assert.equal(checkpoint.events.length, 400);
  assert.equal(completed.checkpoint, false);
  assert.equal(completed.samples.length, 500);
  assert.ok(completed.events.length > checkpoint.events.length);
});

test("RTP-loss diagnostics burst is bounded and cannot be extended continuously", () => {
  const recorder = new StreamDiagnosticsRecorder();
  const startedAt = Date.parse("2026-08-28T12:00:00.000Z");
  recorder.beginSession("bounded-burst", {}, startedAt);
  recorder.record({ ...defaultDiagnostics(), packetsReceived: 1_000 }, startedAt);
  recorder.record({ ...defaultDiagnostics(), packetsReceived: 1_100, packetsLost: 1 }, startedAt + 1_000);
  assert.equal(recorder.isIncidentBurstActive(startedAt + 4_999), true);

  recorder.record({ ...defaultDiagnostics(), packetsReceived: 1_200, packetsLost: 2 }, startedAt + 4_500);
  assert.equal(recorder.isIncidentBurstActive(startedAt + 6_001), false);

  recorder.record({ ...defaultDiagnostics(), packetsReceived: 1_300, packetsLost: 3 }, startedAt + 20_000);
  assert.equal(recorder.isIncidentBurstActive(startedAt + 20_001), false);
  recorder.record({ ...defaultDiagnostics(), packetsReceived: 1_400, packetsLost: 4 }, startedAt + 31_000);
  assert.equal(recorder.isIncidentBurstActive(startedAt + 31_001), true);
});

test("lifetime rollup survives eviction from the 5000-event detail ring", () => {
  const recorder = new StreamDiagnosticsRecorder();
  const startedAt = Date.parse("2026-08-28T12:00:00.000Z");
  recorder.beginSession("rollup-test", { resilientNetworkProfile: "balanced" }, startedAt);
  recorder.record({
    ...defaultDiagnostics(),
    sessionId: "rollup-test",
    packetsReceived: 1_000,
  }, startedAt);
  recorder.record({
    ...defaultDiagnostics(),
    sessionId: "rollup-test",
    packetsReceived: 1_100,
    packetsLost: 9,
    packetLossPercent: 8,
  }, startedAt + 1_000);
  recorder.record({
    ...defaultDiagnostics(),
    sessionId: "rollup-test",
    packetsReceived: 1_200,
    packetsLost: 9,
  }, startedAt + 2_000);
  recorder.record({
    ...defaultDiagnostics(),
    sessionId: "rollup-test",
    packetsReceived: 1_300,
    packetsLost: 9,
    keyFramesDecoded: 1,
  }, startedAt + 2_200);
  recorder.recordEvent({
    type: "keyframe requested",
    detail: "post-burst keyframe",
  }, startedAt + 2_300);
  recorder.recordEvent({
    type: "keyframe request attempt",
    detail: "signaling attempt",
  }, startedAt + 2_301);
  recorder.recordEvent({
    type: "keyframe request sent",
    detail: "signaling accepted",
  }, startedAt + 2_302);

  for (let index = 0; index < 5_100; index += 1) {
    recorder.recordEvent({ type: "diagnostic event", detail: `event ${index}` }, startedAt + 3_000 + index);
  }

  const report = recorder.exportReport(startedAt + 10_000) as any;
  assert.equal(report.events.length, 5_000);
  assert.equal(report.events.some((entry: { type: string }) => entry.type === "RTP_LOSS_STARTED"), false);
  assert.equal(report.summary.eventCount > report.summary.retainedEventCount, true);
  assert.equal(report.summary.eventsTruncated, true);
  assert.equal(report.rollup.eventsTruncated, true);
  assert.equal(report.rollup.rtpLoss.incidentCount, 1);
  assert.equal(report.rollup.rtpLoss.packetsLostDelta, 9);
  assert.equal(report.rollup.rtpLoss.primary.packetsLostDelta, 9);
  assert.equal(report.rollup.rtpLoss.primary.firstDecodedKeyframeAt, "2026-08-28T12:00:02.200Z");
  assert.equal(report.rollup.keyframes.requestCount, 1);
  assert.equal(report.rollup.keyframes.requests.length, 1);
  assert.equal(report.rollup.keyframes.requests[0].type, "KEYFRAME_REQUESTED");
  assert.equal(report.rollup.keyframes.firstDecodedAfterPrimaryLossAt, "2026-08-28T12:00:02.200Z");
});
