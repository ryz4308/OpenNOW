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
    resilientNetworkProfile: true,
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
  }, startedAt);
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
  }, startedAt + 3_300);

  const report = recorder.exportReport(startedAt + 3_300);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("secret-session-id"), false);
  assert.equal(serialized.includes("stream-1"), true);

  const events = report.events as Array<{ type: string; values?: Record<string, unknown> }>;
  assert.equal(events.some((event) => event.type === "NETWORK_STALL"), true);
  assert.equal(events.some((event) => event.type === "RENDER_STALL"), true);
  assert.equal(events.filter((event) => event.type === "RECOVERY_NOTICED").length, 2);
  assert.equal(events.some((event) => event.type === "NACK_INCREASED"), true);
  assert.equal(events.some((event) => event.type === "PLI_INCREASED"), true);

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
