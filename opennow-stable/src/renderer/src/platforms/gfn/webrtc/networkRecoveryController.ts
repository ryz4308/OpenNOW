import type { NetworkRecoveryProfile } from "@shared/gfn";

import { OFFICIAL_MIN_BITRATE_KBPS } from "../sdp/nvstOffer";

export type NetworkRecoveryPhase =
  | "STABLE"
  | "WARNING"
  | "BURST"
  | "RECOVERING"
  | "RECONNECTING";

export type NetworkRecoveryAction =
  | "none"
  | "warning"
  | "keyframe_requested"
  | "bitrate_step_down"
  | "bitrate_step_up"
  | "live_bitrate_unavailable"
  | "reconnecting";

export interface NetworkRecoverySample {
  packetLossPercent: number;
  rttMs: number;
  jitterMs: number;
  receiveFps: number;
  decodeFps: number;
}

export interface NetworkRecoveryState {
  enabled: boolean;
  active: boolean;
  phase: NetworkRecoveryPhase;
  recoveryAttempts: number;
  recoveryAction: NetworkRecoveryAction;
  targetBitrateKbps: number;
  liveBitrateSupported: boolean | null;
}

interface NetworkRecoveryControllerDependencies {
  log: (message: string) => void;
  setMaxBitrateKbps: (kbps: number) => Promise<boolean>;
  requestKeyframe: (request: {
    reason: string;
    backlogFrames: number;
    attempt: number;
  }) => Promise<unknown>;
  onStateChange: (state: NetworkRecoveryState) => void;
  now?: () => number;
}

export interface NetworkRecoveryDecision {
  active: boolean;
  reason: string;
  desiredBitrateKbps: number;
}

const BAD_CONSECUTIVE_POLLS = 2;
const RECOVERING_CONSECUTIVE_POLLS = 5;
const STABLE_CONSECUTIVE_POLLS = 20;
const DOWN_COOLDOWN_MS = 2_500;
const UP_COOLDOWN_MS = 30_000;
export const NETWORK_KEYFRAME_COOLDOWN_MS = 25_000;
const RECOVERY_MIN_BITRATE_KBPS = 5_000;
const RECOVERY_STEP_UP_FACTOR = 1.15;

export function classifyNetworkRecoverySample(
  sample: NetworkRecoverySample,
  negotiatedMaxBitrateKbps: number,
): NetworkRecoveryDecision {
  const packetLoss = Math.max(0, sample.packetLossPercent);
  const rtt = Math.max(0, sample.rttMs);
  const jitter = Math.max(0, sample.jitterMs);
  const receiveFps = Math.max(0, sample.receiveFps);
  const decodeFps = Math.max(0, sample.decodeFps);
  const lowStreamFps = receiveFps > 0 && decodeFps > 0 && receiveFps <= 30 && decodeFps <= 30;

  let desired = negotiatedMaxBitrateKbps;
  let reason = "stable";

  if (packetLoss >= 10 || rtt >= 180 || (packetLoss >= 5 && lowStreamFps)) {
    desired = 5_000;
    reason = packetLoss >= 10 ? "critical_loss" : "critical_rtt";
  } else if (packetLoss >= 5 || rtt >= 140 || jitter >= 25) {
    desired = 8_000;
    reason = packetLoss >= 5 ? "high_loss" : (rtt >= 140 ? "high_rtt" : "high_jitter");
  } else if (packetLoss >= 2 || rtt >= 100 || jitter >= 12) {
    desired = 12_000;
    reason = packetLoss >= 2 ? "moderate_loss" : (rtt >= 100 ? "moderate_rtt" : "moderate_jitter");
  } else if (packetLoss >= 1 || rtt >= 75) {
    desired = 15_000;
    reason = packetLoss >= 1 ? "light_loss" : "light_rtt";
  }

  const normalizedMax = Math.max(RECOVERY_MIN_BITRATE_KBPS, Math.floor(negotiatedMaxBitrateKbps));
  const desiredBitrateKbps = Math.max(
    RECOVERY_MIN_BITRATE_KBPS,
    Math.min(normalizedMax, Math.floor(desired)),
  );

  return {
    active: desiredBitrateKbps < normalizedMax,
    reason,
    desiredBitrateKbps,
  };
}

export class NetworkRecoveryController {
  private profile: NetworkRecoveryProfile = "current";
  private phase: NetworkRecoveryPhase = "STABLE";
  private badConsecutivePolls = 0;
  private stableConsecutivePolls = 0;
  private recoveryAttempts = 0;
  private lastDownshiftAtMs = Number.NEGATIVE_INFINITY;
  private lastUpshiftAtMs = Number.NEGATIVE_INFINITY;
  private lastKeyframeRequestAtMs = Number.NEGATIVE_INFINITY;
  private burstKeyframeRequested = false;
  private negotiatedMaxBitrateKbps = OFFICIAL_MIN_BITRATE_KBPS;
  private currentBitrateCeilingKbps = OFFICIAL_MIN_BITRATE_KBPS;
  private recoveryAction: NetworkRecoveryAction = "none";
  private liveBitrateSupported: boolean | null = null;

  constructor(private readonly dependencies: NetworkRecoveryControllerDependencies) {}

  get targetBitrateKbps(): number {
    return this.currentBitrateCeilingKbps;
  }

  setProfile(profile: NetworkRecoveryProfile): void {
    if (this.profile === profile) {
      return;
    }
    this.profile = profile;
    if (profile === "current") {
      this.phase = "STABLE";
      this.recoveryAction = "none";
      this.badConsecutivePolls = 0;
      this.stableConsecutivePolls = 0;
      this.burstKeyframeRequested = false;
    }
    this.dependencies.log(`Network recovery profile: ${profile}`);
    this.emitState();
  }

  initializeBitrate(maxBitrateKbps: number): void {
    this.negotiatedMaxBitrateKbps = Math.max(
      RECOVERY_MIN_BITRATE_KBPS,
      Math.floor(maxBitrateKbps),
    );
    this.currentBitrateCeilingKbps = this.negotiatedMaxBitrateKbps;
    this.phase = "STABLE";
    this.badConsecutivePolls = 0;
    this.stableConsecutivePolls = 0;
    this.recoveryAttempts = 0;
    this.burstKeyframeRequested = false;
    this.recoveryAction = "none";
    this.liveBitrateSupported = null;
    this.emitState();
  }

  reset(): void {
    this.profile = "current";
    this.phase = "STABLE";
    this.badConsecutivePolls = 0;
    this.stableConsecutivePolls = 0;
    this.recoveryAttempts = 0;
    this.lastDownshiftAtMs = Number.NEGATIVE_INFINITY;
    this.lastUpshiftAtMs = Number.NEGATIVE_INFINITY;
    this.lastKeyframeRequestAtMs = Number.NEGATIVE_INFINITY;
    this.burstKeyframeRequested = false;
    this.negotiatedMaxBitrateKbps = OFFICIAL_MIN_BITRATE_KBPS;
    this.currentBitrateCeilingKbps = OFFICIAL_MIN_BITRATE_KBPS;
    this.recoveryAction = "none";
    this.liveBitrateSupported = null;
    this.emitState();
  }

  markReconnecting(reason: string): void {
    if (this.profile === "current") {
      return;
    }
    this.phase = "RECONNECTING";
    this.recoveryAction = "reconnecting";
    this.dependencies.log(`Network recovery entered RECONNECTING (${reason})`);
    this.emitState();
  }

  markReconnected(): void {
    if (this.profile === "current" || this.phase !== "RECONNECTING") {
      return;
    }
    this.phase = "RECOVERING";
    this.recoveryAction = "none";
    this.stableConsecutivePolls = 0;
    this.dependencies.log("Network recovery entered RECOVERING after reconnect");
    this.emitState();
  }

  async recover(sample: NetworkRecoverySample): Promise<void> {
    if (this.profile === "current" || this.phase === "RECONNECTING") {
      return;
    }

    const decision = classifyNetworkRecoverySample(sample, this.negotiatedMaxBitrateKbps);
    if (decision.active) {
      this.stableConsecutivePolls = 0;
      this.badConsecutivePolls++;

      if (this.badConsecutivePolls < BAD_CONSECUTIVE_POLLS) {
        this.phase = "WARNING";
        this.recoveryAction = "warning";
        this.emitState();
        return;
      }

      const enteringBurst = this.phase !== "BURST";
      this.phase = "BURST";
      if (enteringBurst) {
        this.burstKeyframeRequested = false;
      }
      await this.requestBurstKeyframe(decision.reason);
      await this.stepDown(decision);
      return;
    }

    this.badConsecutivePolls = 0;
    this.stableConsecutivePolls++;
    if (this.phase === "WARNING") {
      this.phase = "STABLE";
      this.recoveryAction = "none";
      this.emitState();
      return;
    }

    if (
      (this.phase === "BURST" || this.phase === "RECOVERING")
      && this.stableConsecutivePolls >= RECOVERING_CONSECUTIVE_POLLS
    ) {
      this.phase = "RECOVERING";
      this.recoveryAction = "none";
      this.emitState();
    }

    if (this.phase === "RECOVERING" && this.stableConsecutivePolls >= STABLE_CONSECUTIVE_POLLS) {
      await this.stepUp();
    }
  }

  private async requestBurstKeyframe(reason: string): Promise<void> {
    if (this.burstKeyframeRequested) {
      return;
    }
    this.burstKeyframeRequested = true;
    const now = this.dependencies.now?.() ?? performance.now();
    if (now - this.lastKeyframeRequestAtMs < NETWORK_KEYFRAME_COOLDOWN_MS) {
      return;
    }

    try {
      await this.dependencies.requestKeyframe({
        reason: `network_${reason}`,
        backlogFrames: 0,
        attempt: this.recoveryAttempts + 1,
      });
      this.lastKeyframeRequestAtMs = now;
      this.recoveryAction = "keyframe_requested";
      this.dependencies.log(`Network recovery requested one keyframe (${reason})`);
      this.emitState();
    } catch (error) {
      this.dependencies.log(`Network recovery keyframe request failed (non-fatal): ${String(error)}`);
    }
  }

  private async stepDown(decision: NetworkRecoveryDecision): Promise<void> {
    if (this.liveBitrateSupported === false) {
      this.recoveryAction = "live_bitrate_unavailable";
      this.emitState();
      return;
    }
    const now = this.dependencies.now?.() ?? performance.now();
    if (now - this.lastDownshiftAtMs < DOWN_COOLDOWN_MS) {
      return;
    }
    const next = Math.min(this.currentBitrateCeilingKbps, decision.desiredBitrateKbps);
    if (next >= this.currentBitrateCeilingKbps) {
      this.emitState();
      return;
    }

    const updated = await this.dependencies.setMaxBitrateKbps(next);
    this.lastDownshiftAtMs = now;
    if (!updated) {
      this.liveBitrateSupported = false;
      this.recoveryAction = "live_bitrate_unavailable";
      this.dependencies.log(
        `Network recovery cannot apply a live bitrate update; keeping negotiated ceiling ${this.currentBitrateCeilingKbps} kbps for this connection`,
      );
      this.emitState();
      return;
    }

    this.liveBitrateSupported = true;
    const previous = this.currentBitrateCeilingKbps;
    this.currentBitrateCeilingKbps = next;
    this.recoveryAttempts++;
    this.recoveryAction = "bitrate_step_down";
    this.dependencies.log(
      `Network recovery: bitrate ceiling stepped down ${previous} -> ${next} kbps (${decision.reason})`,
    );
    this.emitState();
  }

  private async stepUp(): Promise<void> {
    if (this.liveBitrateSupported === false) {
      this.phase = "STABLE";
      this.recoveryAction = "live_bitrate_unavailable";
      this.burstKeyframeRequested = false;
      this.emitState();
      return;
    }
    const now = this.dependencies.now?.() ?? performance.now();
    if (now - this.lastUpshiftAtMs < UP_COOLDOWN_MS) {
      return;
    }
    if (this.currentBitrateCeilingKbps >= this.negotiatedMaxBitrateKbps) {
      this.phase = "STABLE";
      this.recoveryAction = "none";
      this.burstKeyframeRequested = false;
      this.emitState();
      return;
    }

    const next = Math.min(
      this.negotiatedMaxBitrateKbps,
      Math.max(
        this.currentBitrateCeilingKbps + 1_000,
        Math.floor(this.currentBitrateCeilingKbps * RECOVERY_STEP_UP_FACTOR),
      ),
    );
    const updated = await this.dependencies.setMaxBitrateKbps(next);
    this.lastUpshiftAtMs = now;
    if (!updated) {
      this.liveBitrateSupported = false;
      this.recoveryAction = "live_bitrate_unavailable";
      this.emitState();
      return;
    }

    this.liveBitrateSupported = true;
    const previous = this.currentBitrateCeilingKbps;
    this.currentBitrateCeilingKbps = next;
    this.phase = next < this.negotiatedMaxBitrateKbps ? "RECOVERING" : "STABLE";
    this.recoveryAction = "bitrate_step_up";
    if (this.phase === "STABLE") {
      this.burstKeyframeRequested = false;
    }
    this.dependencies.log(
      `Network recovery: bitrate ceiling stepped up ${previous} -> ${next} kbps`,
    );
    this.emitState();
  }

  private emitState(): void {
    const enabled = this.profile !== "current";
    this.dependencies.onStateChange({
      enabled,
      active: enabled && this.phase !== "STABLE",
      phase: this.phase,
      recoveryAttempts: this.recoveryAttempts,
      recoveryAction: this.recoveryAction,
      targetBitrateKbps: this.targetBitrateKbps,
      liveBitrateSupported: this.liveBitrateSupported,
    });
  }
}
