/// <reference types="node" />

import test from "node:test";
import assert from "node:assert/strict";

import {
  DecoderPressureController,
  type DecoderPressureSignal,
  type DecoderPressureState,
} from "./decoderPressureController";
import {
  NetworkRecoveryController,
  classifyNetworkRecoverySample,
  type NetworkRecoveryState,
} from "./networkRecoveryController";
import {
  selectGamepadPollIntervalMs,
  shouldSendGamepadPacket,
} from "./gamepadController";
import { InputChannelPolicyController } from "./inputChannelPolicy";

const pressureSignal: DecoderPressureSignal = {
  active: true,
  reason: "backlog_and_drop",
  backlogFrames: 50,
  dropRatePercent: 7,
};

test("decoder recovery waits for three pressure polls and clears after six stable polls", async () => {
  const states: DecoderPressureState[] = [];
  let keyframeRequests = 0;
  const controller = new DecoderPressureController({
    log: () => {},
    getPeerConnection: () => null,
    getControlChannel: () => null,
    requestSignalingKeyframe: async () => {
      keyframeRequests++;
    },
    setMaxBitrateKbps: async () => true,
    onStateChange: (state) => states.push(state),
    now: () => 2_000,
  });

  await controller.recover(pressureSignal);
  await controller.recover(pressureSignal);
  assert.equal(keyframeRequests, 0);

  await controller.recover(pressureSignal);
  assert.equal(keyframeRequests, 1);
  assert.deepEqual(states.at(-1), {
    active: true,
    recoveryAttempts: 1,
    recoveryAction: "signaling_keyframe",
  });

  const stableSignal = { ...pressureSignal, active: false, reason: "stable" };
  for (let index = 0; index < 5; index++) {
    await controller.recover(stableSignal);
  }
  assert.equal(states.at(-1)?.active, true);

  await controller.recover(stableSignal);
  assert.deepEqual(states.at(-1), {
    active: false,
    recoveryAttempts: 0,
    recoveryAction: "none",
  });
});

test("decoder recovery preserves bitrate state when no wire update is applied", async () => {
  const states: DecoderPressureState[] = [];
  const logs: string[] = [];
  const requestedBitrates: number[] = [];
  let updateApplied = false;
  let now = 2_000;
  const peerConnection = {
    localDescription: { type: "answer", sdp: "v=0\r\n" },
    getSenders: () => [],
  } as unknown as RTCPeerConnection;
  const controller = new DecoderPressureController({
    log: (message) => logs.push(message),
    getPeerConnection: () => peerConnection,
    getControlChannel: () => null,
    requestSignalingKeyframe: async () => {
      throw new Error("unavailable");
    },
    setMaxBitrateKbps: async (kbps) => {
      requestedBitrates.push(kbps);
      return updateApplied;
    },
    onStateChange: (state) => states.push(state),
    now: () => now,
  });
  controller.initializeBitrate(10_000);

  await controller.recover(pressureSignal);
  await controller.recover(pressureSignal);
  await controller.recover(pressureSignal);

  assert.deepEqual(requestedBitrates, [8_500]);
  assert.deepEqual(states.at(-1), {
    active: true,
    recoveryAttempts: 0,
    recoveryAction: "none",
  });
  assert.equal(logs.some((message) => message.includes("bitrate ceiling stepped down")), false);

  updateApplied = true;
  now = 4_000;
  await controller.recover(pressureSignal);

  assert.deepEqual(requestedBitrates, [8_500, 8_500]);
  assert.deepEqual(states.at(-1), {
    active: true,
    recoveryAttempts: 1,
    recoveryAction: "bitrate_step_down",
  });
  assert.equal(
    logs.some((message) => message.includes("bitrate ceiling stepped down 10000 -> 8500 kbps")),
    true,
  );
});

test("smooth playback buffer applies bounded receiver targets and reports support", () => {
  const controller = new DecoderPressureController({
    log: () => {},
    getPeerConnection: () => null,
    getControlChannel: () => null,
    requestSignalingKeyframe: async () => {},
    setMaxBitrateKbps: async () => false,
    onStateChange: () => {},
  });
  const receiver = {
    jitterBufferTarget: null,
    playoutDelayHint: null,
    track: { contentHint: "" },
  } as unknown as RTCRtpReceiver;

  controller.setSmoothPlaybackBufferEnabled(true);
  controller.configureReceiver(receiver, "video");

  assert.equal((receiver as unknown as { jitterBufferTarget: number }).jitterBufferTarget, 45);
  assert.equal((receiver as unknown as { playoutDelayHint: number }).playoutDelayHint, 0.045);
  assert.deepEqual(controller.getReceiverTuningDiagnostics(), {
    smoothPlaybackBufferEnabled: true,
    videoTargetMs: 45,
    audioTargetMs: 48,
    appliedCount: 1,
    jitterBufferTargetSupported: true,
    playoutDelayHintSupported: true,
  });
});

test("network recovery classifies critical packet loss as a low bitrate target", () => {
  const decision = classifyNetworkRecoverySample({
    packetLossPercent: 12,
    rttMs: 55,
    jitterMs: 5,
    receiveFps: 60,
    decodeFps: 60,
  }, 20_000);

  assert.deepEqual(decision, {
    active: true,
    reason: "critical_loss",
    desiredBitrateKbps: 5_000,
  });
});

test("network recovery does not downshift from low stream fps alone", () => {
  const decision = classifyNetworkRecoverySample({
    packetLossPercent: 0,
    rttMs: 45,
    jitterMs: 2,
    receiveFps: 12,
    decodeFps: 12,
  }, 20_000);

  assert.deepEqual(decision, {
    active: false,
    reason: "stable",
    desiredBitrateKbps: 20_000,
  });
});

test("network recovery steps bitrate down under repeated loss and slowly restores it", async () => {
  const states: NetworkRecoveryState[] = [];
  const requestedBitrates: number[] = [];
  let now = 10_000;
  const controller = new NetworkRecoveryController({
    log: () => {},
    setMaxBitrateKbps: async (kbps) => {
      requestedBitrates.push(kbps);
      return true;
    },
    onStateChange: (state) => states.push(state),
    now: () => now,
  });
  controller.initializeBitrate(20_000);
  controller.setEnabled(true);

  const lossySample = {
    packetLossPercent: 14,
    rttMs: 60,
    jitterMs: 4,
    receiveFps: 60,
    decodeFps: 60,
  };

  await controller.recover(lossySample);
  assert.deepEqual(requestedBitrates, []);

  now += 3_000;
  await controller.recover(lossySample);
  assert.deepEqual(requestedBitrates, [5_000]);
  assert.deepEqual(states.at(-1), {
    enabled: true,
    active: true,
    recoveryAttempts: 1,
    recoveryAction: "bitrate_step_down",
    targetBitrateKbps: 5_000,
  });

  now += 31_000;
  const stableSample = {
    packetLossPercent: 0,
    rttMs: 48,
    jitterMs: 2,
    receiveFps: 60,
    decodeFps: 60,
  };
  for (let index = 0; index < 20; index++) {
    await controller.recover(stableSample);
  }

  assert.deepEqual(requestedBitrates, [5_000, 6_000]);
  assert.deepEqual(states.at(-1), {
    enabled: true,
    active: true,
    recoveryAttempts: 1,
    recoveryAction: "bitrate_step_up",
    targetBitrateKbps: 6_000,
  });
});

test("network recovery reports unavailable when live bitrate update is not supported", async () => {
  const states: NetworkRecoveryState[] = [];
  const requestedBitrates: number[] = [];
  let now = 10_000;
  const controller = new NetworkRecoveryController({
    log: () => {},
    setMaxBitrateKbps: async (kbps) => {
      requestedBitrates.push(kbps);
      return false;
    },
    onStateChange: (state) => states.push(state),
    now: () => now,
  });
  controller.initializeBitrate(20_000);
  controller.setEnabled(true);

  await controller.recover({
    packetLossPercent: 0,
    rttMs: 220,
    jitterMs: 5,
    receiveFps: 60,
    decodeFps: 60,
  });
  now += 3_000;
  await controller.recover({
    packetLossPercent: 0,
    rttMs: 220,
    jitterMs: 5,
    receiveFps: 60,
    decodeFps: 60,
  });

  assert.deepEqual(requestedBitrates, [5_000]);
  assert.deepEqual(states.at(-1), {
    enabled: true,
    active: true,
    recoveryAttempts: 0,
    recoveryAction: "unavailable",
    targetBitrateKbps: 20_000,
  });
});

test("input policy preserves native, partially-reliable, and fallback routes", () => {
  const nativePackets: Array<{ payload: Uint8Array; partiallyReliable: boolean }> = [];
  const reliablePackets: Uint8Array[] = [];
  const channelPackets: Uint8Array[] = [];
  let nativeActive = true;
  let channelOpen = true;
  const channel = {
    get readyState() {
      return channelOpen ? "open" : "closed";
    },
    send: (payload: Uint8Array) => channelPackets.push(payload),
  } as unknown as RTCDataChannel;
  const controller = new InputChannelPolicyController(
    {
      partialReliableThresholdMs: 300,
      hidDeviceMask: 0xffff,
      enablePartiallyReliableTransferGamepad: 0xffff,
      enablePartiallyReliableTransferHid: 0xffff,
    },
    {
      isNativeInputActive: () => nativeActive,
      getPartiallyReliableChannel: () => channel,
      sendNativeInput: (payload, partiallyReliable) => {
        nativePackets.push({ payload, partiallyReliable });
      },
      sendReliable: (payload) => reliablePackets.push(payload),
    },
  );
  const payload = new Uint8Array([1, 2, 3]);

  controller.sendPartiallyReliable(payload);
  assert.deepEqual(nativePackets, [{ payload, partiallyReliable: true }]);

  nativeActive = false;
  controller.sendPartiallyReliable(payload);
  assert.equal(channelPackets.length, 1);

  channelOpen = false;
  controller.sendPartiallyReliable(payload);
  assert.deepEqual(reliablePackets, [payload]);
});

test("gamepad polling and keepalive decisions preserve adaptive timing", () => {
  assert.equal(selectGamepadPollIntervalMs({
    inputReady: false,
    visible: true,
    connectedCount: 1,
    inputBlocked: false,
  }), 100);
  assert.equal(selectGamepadPollIntervalMs({
    inputReady: true,
    visible: true,
    connectedCount: 1,
    inputBlocked: true,
  }), 16);
  assert.equal(selectGamepadPollIntervalMs({
    inputReady: true,
    visible: true,
    connectedCount: 1,
    inputBlocked: false,
  }), 4);
  assert.equal(shouldSendGamepadPacket(false, 99), false);
  assert.equal(shouldSendGamepadPacket(false, 100), true);
  assert.equal(shouldSendGamepadPacket(true, 0), true);
});
