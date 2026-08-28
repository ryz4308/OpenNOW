import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  StreamDiagnosticsPersistence,
  buildCompactDiagnosticsSummary,
} from "./streamDiagnosticsPersistence";

const startedAt = "2026-08-28T12:00:00.000Z";

function event(
  elapsedMs: number,
  type: string,
  detail: string,
  values?: Record<string, number | string | boolean>,
) {
  return {
    timestamp: new Date(Date.parse(startedAt) + elapsedMs).toISOString(),
    elapsedMs,
    type,
    detail,
    values,
  };
}

function report(events: ReturnType<typeof event>[]) {
  return {
    schemaVersion: 6,
    captureStartedAt: startedAt,
    captureFinishedAt: new Date(Date.parse(startedAt) + 10_000).toISOString(),
    context: { resilientNetworkProfile: "survival" },
    events,
    samples: [{ timestamp: startedAt, packetsLost: 0 }],
  };
}

test("builds a compact route/NVIDIA summary with exact recovery and exit evidence", () => {
  const summary = buildCompactDiagnosticsSummary(report([
    event(900, "GATEWAY_PING", "gateway replied", { success: true, latencyMs: 2, failure: "none" }),
    event(1_000, "RTP_LOSS_STARTED", "loss", {
      gatewaySuccess: true,
      gatewayLatencyMs: 2,
    }),
    event(1_000, "RTP_LOSS_INCREMENT", "lost 4", { delta: 4 }),
    event(1_200, "KEYFRAME_REQUEST_ATTEMPT", "request", { reason: "network-burst" }),
    event(1_250, "KEYFRAME_REQUEST_SENT", "sent", { reason: "network-burst" }),
    event(1_600, "KEYFRAME_DECODED", "decoded", { delta: 1 }),
    event(2_000, "RTP_LOSS_ENDED", "ended", { durationMs: 1_000, packetsLostDelta: 4 }),
    event(2_100, "ICE_CONNECTION_STATE", "connected", { state: "connected" }),
    event(2_200, "GATEWAY_WEBSOCKET_CONNECTED", "connected"),
    event(2_300, "MEDIA_TRACK_RECEIVED", "video", { kind: "video" }),
    event(3_000, "CLOUDMATCH_RECOVERY_STARTED", "resume", { profile: "survival" }),
    event(3_500, "CLOUDMATCH_CLAIM_CONNECTED", "reconnected", { attempt: 1 }),
    event(3_800, "SEAMLESS_RESUME_SUCCEEDED", "video and control restored", { profile: "survival" }),
    event(4_000, "CLOUDMATCH_STATUS", "status 3", { status: 3 }),
    event(4_100, "REMOTE_GAME_PROCESS_STATE", "running", { state: "running" }),
    event(10_000, "SESSION_EXIT", "remote ended", { source: "remote", reasonCode: "remote_reason" }),
  ]), "C:\\diagnostics\\full.json") as any;

  assert.equal(summary.recoveryProfile, "survival");
  assert.equal(summary.rtpLoss.primary.durationMs, 1_000);
  assert.equal(summary.rtpLoss.primary.packetsLostDelta, 4);
  assert.equal(summary.keyframes.newKeyframeAfterPrimaryLossAt, "2026-08-28T12:00:01.600Z");
  assert.equal(summary.seamlessResume.result, "succeeded");
  assert.equal(summary.sessionExit.reason, "remote ended");
  assert.equal(summary.probableProblemCategory, "route_or_nvidia");
  assert.equal(summary.fullDiagnosticsPath, "C:\\diagnostics\\full.json");
  assert.equal(summary.transportEvents.ice.length, 1);
  assert.equal(summary.transportEvents.webSocket.length, 1);
  assert.equal(summary.transportEvents.videoTrack.length, 1);
});

test("classifies simultaneous gateway failure as local network", () => {
  const summary = buildCompactDiagnosticsSummary(report([
    event(1_000, "RTP_LOSS_STARTED", "loss", {
      gatewaySuccess: false,
      gatewayLatencyMs: -1,
    }),
    event(1_000, "RTP_LOSS_INCREMENT", "lost 9", { delta: 9 }),
    event(1_200, "KEYFRAME_REQUEST_SENT", "sent"),
  ]), "/diagnostics/full.json") as any;

  assert.equal(summary.probableProblemCategory, "local_network");
  assert.equal(summary.rtpLoss.primary.gatewayPingAtStart.success, false);
});

test("classifies a missing post-request keyframe as decoder/keyframe", () => {
  const summary = buildCompactDiagnosticsSummary(report([
    event(900, "GATEWAY_PING", "gateway replied", { success: true, latencyMs: 1, failure: "none" }),
    event(1_000, "RTP_LOSS_STARTED", "loss", { gatewaySuccess: true, gatewayLatencyMs: 1 }),
    event(1_000, "RTP_LOSS_INCREMENT", "lost 1", { delta: 1 }),
    event(1_100, "KEYFRAME_REQUEST_SENT", "sent"),
  ]), "/diagnostics/full.json") as any;

  assert.equal(summary.probableProblemCategory, "decoder_or_keyframe");
  assert.equal(summary.keyframes.newKeyframeAfterPrimaryLossAt, null);
});

test("checkpoints and finalizes separate full and compact files after renderer crash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opennow-diagnostics-"));
  try {
    const persistence = new StreamDiagnosticsPersistence(directory);
    await persistence.initialize();
    await persistence.save({ phase: "checkpoint", report: report([]) });
    assert.deepEqual(await readdir(directory), ["active-session-diagnostics.json"]);

    const result = await persistence.finalizeUnexpected(
      "renderer_crashed",
      "Renderer process gone: crashed (exit code 9)",
    );
    assert.ok(result.fullDiagnosticsPath);
    assert.ok(result.summaryPath);
    const summary = JSON.parse(await readFile(result.summaryPath!, "utf8"));
    assert.equal(summary.sessionExit.reasonCode, "renderer_crashed");
    assert.equal(summary.sessionExit.reason, "Renderer process gone: crashed (exit code 9)");
    assert.equal(summary.fullDiagnosticsPath, result.fullDiagnosticsPath);
    assert.equal((await readdir(directory)).includes("active-session-diagnostics.json"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("next startup automatically finalizes a stale crash checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opennow-diagnostics-stale-"));
  try {
    const firstProcess = new StreamDiagnosticsPersistence(directory);
    await firstProcess.initialize();
    await firstProcess.save({ phase: "checkpoint", report: report([]) });

    const nextProcess = new StreamDiagnosticsPersistence(directory);
    await nextProcess.initialize();
    const files = await readdir(directory);
    const summaryName = files.find((name) => name.startsWith("opennow-summary-"));
    assert.ok(summaryName);
    const summary = JSON.parse(await readFile(join(directory, summaryName), "utf8"));
    assert.equal(summary.sessionExit.reasonCode, "previous_process_terminated");
    assert.equal(summary.probableProblemCategory, "undetermined");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
