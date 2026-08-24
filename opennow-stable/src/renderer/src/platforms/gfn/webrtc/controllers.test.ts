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

test("network buffer overrides decoder latency and suppresses mid-burst keyframes", async () => {
  let keyframeRequests = 0;
  let now = 2_000;
  const receiver = {
    jitterBufferTarget: null,
    playoutDelayHint: null,
    track: { contentHint: "" },
  } as unknown as RTCRtpReceiver;
  const controller = new DecoderPressureController({
    log: () => {},
    getPeerConnection: () => null,
    getControlChannel: () => null,
    requestSignalingKeyframe: async () => {
      keyframeRequests++;
    },
    setMaxBitrateKbps: async () => true,
    onStateChange: () => {},
    now: () => now,
  });
  controller.configureReceiver(receiver, "video");
  controller.setNetworkRecoveryBufferTargetMs(110);
  assert.equal((receiver as unknown as { jitterBufferTarget: number | null }).jitterBufferTarget, 110);

  controller.setNetworkRecoveryGuardActive(true);
  await controller.recover(pressureSignal);
  await controller.recover(pressureSignal);
  await controller.recover(pressureSignal);
  assert.equal(keyframeRequests, 0);

  controller.setNetworkRecoveryBufferTargetMs(45);
  assert.equal((receiver as unknown as { jitterBufferTarget: number | null }).jitterBufferTarget, 45);
  controller.setNetworkRecoveryGuardActive(false);
  now += 2_000;
  await controller.recover(pressureSignal);
  assert.equal(keyframeRequests, 1);

  controller.setNetworkRecoveryBufferTargetMs(null);
  // Decoder pressure is still active, so its smaller 30ms target remains.
  assert.equal((receiver as unknown as { jitterBufferTarget: number | null }).jitterBufferTarget, 30);
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
    phase: "burst",
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
    phase: "stable",
    reason: "stable",
    desiredBitrateKbps: 20_000,
  });
});

test("network recovery raises the buffer during a burst and requests one keyframe after it", async () => {
  const states: NetworkRecoveryState[] = [];
  const requestedBitrates: number[] = [];
  const bufferTargets: Array<number | null> = [];
  const keyframeReasons: string[] = [];
  let now = 10_000;
  const controller = new NetworkRecoveryController({
    log: () => {},
    setMaxBitrateKbps: async (kbps) => {
      requestedBitrates.push(kbps);
      return true;
    },
    setReceiverBufferTargetMs: (target) => bufferTargets.push(target),
    requestPostBurstKeyframe: async (reason) => {
      keyframeReasons.push(reason);
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
  assert.equal(states.at(-1)?.phase, "burst");
  assert.equal(states.at(-1)?.bufferTargetMs, 110);

  now += 3_000;
  await controller.recover(lossySample);
  assert.deepEqual(requestedBitrates, [5_000]);
  assert.equal(states.at(-1)?.recoveryAction, "bitrate_step_down");
  assert.equal(states.at(-1)?.targetBitrateKbps, 5_000);

  now += 1_000;
  await controller.recover({
    packetLossPercent: 1,
    rttMs: 60,
    jitterMs: 4,
    receiveFps: 58,
    decodeFps: 58,
  });
  assert.equal(states.at(-1)?.phase, "burst");
  assert.deepEqual(keyframeReasons, []);

  const stableSample = {
    packetLossPercent: 0,
    rttMs: 48,
    jitterMs: 2,
    receiveFps: 60,
    decodeFps: 60,
  };
  now += 1_000;
  await controller.recover(stableSample);
  now += 1_000;
  await controller.recover(stableSample);
  assert.equal(states.at(-1)?.phase, "recovering");
  assert.equal(states.at(-1)?.bufferTargetMs, 45);
  assert.equal(states.at(-1)?.recoveryAction, "post_burst_keyframe");
  assert.deepEqual(keyframeReasons, ["post_burst_stable"]);

  now += 11_000;
  for (let index = 0; index < 7; index++) await controller.recover(stableSample);
  assert.equal(states.at(-1)?.phase, "stable");
  assert.equal(states.at(-1)?.bufferTargetMs, null);
  assert.deepEqual(requestedBitrates, [5_000, 6_000]);
  assert.deepEqual(bufferTargets, [null, 110, 45, null]);
});

test("network recovery reports live bitrate unavailable once and suppresses false retries", async () => {
  const states: NetworkRecoveryState[] = [];
  const requestedBitrates: number[] = [];
  let now = 10_000;
  const controller = new NetworkRecoveryController({
    log: () => {},
    setMaxBitrateKbps: async (kbps) => {
      requestedBitrates.push(kbps);
      return false;
    },
    setReceiverBufferTargetMs: () => {},
    requestPostBurstKeyframe: async () => false,
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
  now += 3_000;
  await controller.recover({
    packetLossPercent: 0,
    rttMs: 220,
    jitterMs: 5,
    receiveFps: 60,
    decodeFps: 60,
  });

  assert.deepEqual(requestedBitrates, [5_000]);
  assert.equal(states.at(-1)?.phase, "burst");
  assert.equal(states.at(-1)?.recoveryAttempts, 0);
  assert.equal(states.at(-1)?.recoveryAction, "unavailable");
  assert.equal(states.at(-1)?.targetBitrateKbps, 20_000);
  assert.equal(states.at(-1)?.liveBitrateUpdateSupported, false);
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
