import { OFFICIAL_MIN_BITRATE_KBPS } from "../sdp/nvstOffer";

export type NetworkRecoveryPhase = "stable" | "warning" | "burst" | "recovering";

export type NetworkRecoveryAction =
  | "none"
  | "buffer_warning"
  | "buffer_burst"
  | "buffer_recovery"
  | "post_burst_keyframe"
  | "bitrate_step_down"
  | "bitrate_step_up"
  | "unavailable";

export interface NetworkRecoverySample {
  packetLossPercent: number;
  rttMs: number;
  jitterMs: number;
  receiveFps: number;
  decodeFps: number;
  nackDelta?: number;
  pliDelta?: number;
  freezeDelta?: number;
  rttBaselineMs?: number;
}

export interface NetworkRecoveryState {
  enabled: boolean;
  active: boolean;
  phase: NetworkRecoveryPhase;
  reason: string;
  bufferTargetMs: number | null;
  liveBitrateUpdateSupported: boolean | null;
  recoveryAttempts: number;
  recoveryAction: NetworkRecoveryAction;
  targetBitrateKbps: number;
}

interface NetworkRecoveryControllerDependencies {
  log: (message: string) => void;
  setMaxBitrateKbps: (kbps: number) => Promise<boolean>;
  setReceiverBufferTargetMs: (targetMs: number | null) => void;
  requestPostBurstKeyframe: (reason: string) => Promise<boolean>;
  onStateChange: (state: NetworkRecoveryState) => void;
  now?: () => number;
}

export interface NetworkRecoveryDecision {
  active: boolean;
  phase: Exclude<NetworkRecoveryPhase, "recovering">;
  reason: string;
  desiredBitrateKbps: number;
}

const BURST_BUFFER_TARGET_MS = 110;
const WARNING_BUFFER_TARGET_MS = 55;
const RECOVERY_BUFFER_TARGET_MS = 45;
const BURST_CONFIRM_POLLS = 2;
const POST_BURST_STABLE_POLLS = 2;
const RECOVERY_STABLE_POLLS = 9;
const DOWN_COOLDOWN_MS = 2_500;
const UP_COOLDOWN_MS = 10_000;
const KEYFRAME_COOLDOWN_MS = 5_000;
const RECOVERY_MIN_BITRATE_KBPS = 5_000;
const RECOVERY_STEP_UP_FACTOR = 1.15;

function finiteNonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

export function classifyNetworkRecoverySample(
  sample: NetworkRecoverySample,
  negotiatedMaxBitrateKbps: number,
): NetworkRecoveryDecision {
  const packetLoss = finiteNonNegative(sample.packetLossPercent);
  const rtt = finiteNonNegative(sample.rttMs);
  const jitter = finiteNonNegative(sample.jitterMs);
  const receiveFps = finiteNonNegative(sample.receiveFps);
  const decodeFps = finiteNonNegative(sample.decodeFps);
  const nackDelta = finiteNonNegative(sample.nackDelta);
  const pliDelta = finiteNonNegative(sample.pliDelta);
  const freezeDelta = finiteNonNegative(sample.freezeDelta);
  const rttJump = sample.rttBaselineMs === undefined
    ? 0
    : Math.max(0, rtt - finiteNonNegative(sample.rttBaselineMs));
  const lowStreamFps = receiveFps > 0 && decodeFps > 0
    && receiveFps <= 35 && decodeFps <= 35;
  const normalizedMax = Math.max(
    RECOVERY_MIN_BITRATE_KBPS,
    Math.floor(negotiatedMaxBitrateKbps),
  );

  let phase: NetworkRecoveryDecision["phase"] = "stable";
  let reason = "stable";
  let desired = normalizedMax;

  if (freezeDelta > 0 || packetLoss >= 8 || rtt >= 180 || jitter >= 35) {
    phase = "burst";
    desired = 5_000;
    reason = freezeDelta > 0
      ? "freeze_reported"
      : packetLoss >= 8
        ? "critical_loss"
        : rtt >= 180
          ? "critical_rtt"
          : "critical_jitter";
  } else if (
    packetLoss >= 3
    || rtt >= 120
    || rttJump >= 60
    || jitter >= 18
    || pliDelta > 0
    || nackDelta >= 25
    || (lowStreamFps && packetLoss >= 1)
  ) {
    phase = "burst";
    desired = 8_000;
    reason = packetLoss >= 3
      ? "high_loss"
      : rtt >= 120 || rttJump >= 60
        ? "high_rtt"
        : jitter >= 18
          ? "high_jitter"
          : pliDelta > 0
            ? "pli_burst"
            : nackDelta >= 25
              ? "nack_burst"
              : "loss_with_low_fps";
  } else if (
    packetLoss >= 0.75
    || rtt >= 80
    || rttJump >= 30
    || jitter >= 8
    || nackDelta >= 8
  ) {
    phase = "warning";
    desired = 15_000;
    reason = packetLoss >= 0.75
      ? "light_loss"
      : rtt >= 80 || rttJump >= 30
        ? "rtt_rising"
        : jitter >= 8
          ? "jitter_rising"
          : "nack_rising";
  }

  const desiredBitrateKbps = Math.max(
    RECOVERY_MIN_BITRATE_KBPS,
    Math.min(normalizedMax, Math.floor(desired)),
  );
  return {
    active: phase !== "stable",
    phase,
    reason,
    desiredBitrateKbps,
  };
}

export class NetworkRecoveryController {
  private enabled = false;
  private phase: NetworkRecoveryPhase = "stable";
  private reason = "stable";
  private bufferTargetMs: number | null = null;
  private badConsecutivePolls = 0;
  private stableConsecutivePolls = 0;
  private recoveryAttempts = 0;
  private lastDownshiftAtMs = Number.NEGATIVE_INFINITY;
  private lastUpshiftAtMs = Number.NEGATIVE_INFINITY;
  private lastKeyframeRequestAtMs = Number.NEGATIVE_INFINITY;
  private negotiatedMaxBitrateKbps = OFFICIAL_MIN_BITRATE_KBPS;
  private currentBitrateCeilingKbps = OFFICIAL_MIN_BITRATE_KBPS;
  private recoveryAction: NetworkRecoveryAction = "none";
  private liveBitrateUpdateSupported: boolean | null = null;
  private rttBaselineMs: number | null = null;
  private postBurstKeyframePending = false;

  constructor(private readonly dependencies: NetworkRecoveryControllerDependencies) {}

  get targetBitrateKbps(): number {
    return this.enabled
      ? this.currentBitrateCeilingKbps
      : this.negotiatedMaxBitrateKbps;
  }

  get currentPhase(): NetworkRecoveryPhase {
    return this.phase;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.transitionTo("stable", "disabled", null, "none");
    this.dependencies.log(`Adaptive Burst Recovery v3 ${enabled ? "enabled" : "disabled"}`);
    this.emitState();
  }

  initializeBitrate(maxBitrateKbps: number): void {
    this.negotiatedMaxBitrateKbps = Math.max(
      RECOVERY_MIN_BITRATE_KBPS,
      Math.floor(maxBitrateKbps),
    );
    this.currentBitrateCeilingKbps = this.negotiatedMaxBitrateKbps;
    this.phase = "stable";
    this.reason = "stable";
    this.bufferTargetMs = null;
    this.badConsecutivePolls = 0;
    this.stableConsecutivePolls = 0;
    this.recoveryAttempts = 0;
    this.recoveryAction = "none";
    this.liveBitrateUpdateSupported = null;
    this.rttBaselineMs = null;
    this.postBurstKeyframePending = false;
    this.dependencies.setReceiverBufferTargetMs(null);
    this.emitState();
  }

  reset(): void {
    this.phase = "stable";
    this.reason = "stable";
    this.bufferTargetMs = null;
    this.badConsecutivePolls = 0;
    this.stableConsecutivePolls = 0;
    this.recoveryAttempts = 0;
    this.lastDownshiftAtMs = Number.NEGATIVE_INFINITY;
    this.lastUpshiftAtMs = Number.NEGATIVE_INFINITY;
    this.lastKeyframeRequestAtMs = Number.NEGATIVE_INFINITY;
    this.negotiatedMaxBitrateKbps = OFFICIAL_MIN_BITRATE_KBPS;
    this.currentBitrateCeilingKbps = OFFICIAL_MIN_BITRATE_KBPS;
    this.recoveryAction = "none";
    this.liveBitrateUpdateSupported = null;
    this.rttBaselineMs = null;
    this.postBurstKeyframePending = false;
    this.dependencies.setReceiverBufferTargetMs(null);
    this.emitState();
  }

  async recover(sample: NetworkRecoverySample): Promise<void> {
    if (!this.enabled) return;
    const decision = classifyNetworkRecoverySample({
      ...sample,
      rttBaselineMs: this.rttBaselineMs ?? undefined,
    }, this.negotiatedMaxBitrateKbps);

    if (decision.phase === "burst") {
      this.stableConsecutivePolls = 0;
      this.badConsecutivePolls++;
      this.postBurstKeyframePending = this.postBurstKeyframePending
        || finiteNonNegative(sample.freezeDelta) > 0
        || finiteNonNegative(sample.pliDelta) > 0
        || sample.packetLossPercent >= 3
        || (sample.receiveFps > 0 && sample.receiveFps < 45);
      this.transitionTo("burst", decision.reason, BURST_BUFFER_TARGET_MS, "buffer_burst");
      if (this.badConsecutivePolls >= BURST_CONFIRM_POLLS) await this.stepDown(decision);
      return;
    }

    if (decision.phase === "warning") {
      this.stableConsecutivePolls = 0;
      this.badConsecutivePolls = Math.max(1, this.badConsecutivePolls);
      if (this.phase === "burst") {
        // The path is improving but is not stable yet. Keep burst protection
        // and postpone the keyframe until two genuinely clean samples arrive.
        this.transitionTo("burst", decision.reason, BURST_BUFFER_TARGET_MS, "buffer_burst");
      } else {
        this.transitionTo("warning", decision.reason, WARNING_BUFFER_TARGET_MS, "buffer_warning");
      }
      return;
    }

    this.badConsecutivePolls = 0;
    this.stableConsecutivePolls++;
    this.updateRttBaseline(sample.rttMs);
    if (this.phase === "burst" || this.phase === "warning") {
      if (this.stableConsecutivePolls < POST_BURST_STABLE_POLLS) return;
      this.transitionTo("recovering", "post_burst_stable", RECOVERY_BUFFER_TARGET_MS, "buffer_recovery");
      await this.requestPostBurstKeyframe();
      return;
    }
    if (this.phase === "recovering") {
      if (this.stableConsecutivePolls >= RECOVERY_STABLE_POLLS) {
        await this.stepUp();
        this.transitionTo("stable", "stable", null, "none");
      }
      return;
    }
    this.transitionTo("stable", "stable", null, "none");
  }

  private updateRttBaseline(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs <= 0) return;
    this.rttBaselineMs = this.rttBaselineMs === null
      ? rttMs
      : this.rttBaselineMs * 0.9 + rttMs * 0.1;
  }

  private transitionTo(
    phase: NetworkRecoveryPhase,
    reason: string,
    bufferTargetMs: number | null,
    action: NetworkRecoveryAction,
  ): void {
    const changed = this.phase !== phase
      || this.reason !== reason
      || this.bufferTargetMs !== bufferTargetMs;
    this.phase = phase;
    this.reason = reason;
    if (changed) this.recoveryAction = action;
    if (this.bufferTargetMs !== bufferTargetMs) {
      this.bufferTargetMs = bufferTargetMs;
      this.dependencies.setReceiverBufferTargetMs(bufferTargetMs);
    }
    if (changed) {
      this.dependencies.log(
        `Adaptive Burst Recovery: phase=${phase} reason=${reason} buffer=${bufferTargetMs ?? "adaptive"}ms`,
      );
      this.emitState();
    }
  }

  private async requestPostBurstKeyframe(): Promise<void> {
    if (!this.postBurstKeyframePending) return;
    this.postBurstKeyframePending = false;
    const now = this.dependencies.now?.() ?? performance.now();
    if (now - this.lastKeyframeRequestAtMs < KEYFRAME_COOLDOWN_MS) return;
    this.lastKeyframeRequestAtMs = now;
    const requested = await this.dependencies.requestPostBurstKeyframe(this.reason);
    if (!requested) {
      this.dependencies.log("Adaptive Burst Recovery: post-burst keyframe request unavailable");
      return;
    }
    this.recoveryAttempts++;
    this.recoveryAction = "post_burst_keyframe";
    this.dependencies.log("Adaptive Burst Recovery: requested one post-burst keyframe");
    this.emitState();
  }

  private async stepDown(decision: NetworkRecoveryDecision): Promise<void> {
    if (this.liveBitrateUpdateSupported === false) return;
    const now = this.dependencies.now?.() ?? performance.now();
    if (now - this.lastDownshiftAtMs < DOWN_COOLDOWN_MS) return;
    const next = Math.min(this.currentBitrateCeilingKbps, decision.desiredBitrateKbps);
    if (next >= this.currentBitrateCeilingKbps) return;
    const updated = await this.dependencies.setMaxBitrateKbps(next);
    this.lastDownshiftAtMs = now;
    if (!updated) {
      this.liveBitrateUpdateSupported = false;
      this.recoveryAction = "unavailable";
      this.dependencies.log(
        `Adaptive Burst Recovery wanted ${this.currentBitrateCeilingKbps} -> ${next} kbps (${decision.reason}), but the receiver-only transport cannot apply a live bitrate ceiling; future false attempts are suppressed`,
      );
      this.emitState();
      return;
    }
    const previous = this.currentBitrateCeilingKbps;
    this.liveBitrateUpdateSupported = true;
    this.currentBitrateCeilingKbps = next;
    this.recoveryAttempts++;
    this.recoveryAction = "bitrate_step_down";
    this.dependencies.log(
      `Adaptive Burst Recovery: live bitrate ceiling stepped down ${previous} -> ${next} kbps (${decision.reason})`,
    );
    this.emitState();
  }

  private async stepUp(): Promise<void> {
    if (this.liveBitrateUpdateSupported !== true) return;
    const now = this.dependencies.now?.() ?? performance.now();
    if (now - this.lastUpshiftAtMs < UP_COOLDOWN_MS) return;
    if (this.currentBitrateCeilingKbps >= this.negotiatedMaxBitrateKbps) return;
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
      this.liveBitrateUpdateSupported = false;
      this.recoveryAction = "unavailable";
      this.emitState();
      return;
    }
    const previous = this.currentBitrateCeilingKbps;
    this.currentBitrateCeilingKbps = next;
    this.recoveryAction = "bitrate_step_up";
    this.dependencies.log(
      `Adaptive Burst Recovery: live bitrate ceiling stepped up ${previous} -> ${next} kbps`,
    );
    this.emitState();
  }

  private emitState(): void {
    this.dependencies.onStateChange({
      enabled: this.enabled,
      active: this.enabled && this.phase !== "stable",
      phase: this.phase,
      reason: this.reason,
      bufferTargetMs: this.bufferTargetMs,
      liveBitrateUpdateSupported: this.liveBitrateUpdateSupported,
      recoveryAttempts: this.recoveryAttempts,
      recoveryAction: this.recoveryAction,
      targetBitrateKbps: this.targetBitrateKbps,
    });
  }
}
