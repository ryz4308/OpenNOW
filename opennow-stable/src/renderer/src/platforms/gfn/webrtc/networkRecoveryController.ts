import { OFFICIAL_MIN_BITRATE_KBPS } from "../sdp/nvstOffer";

export type NetworkRecoveryAction =
  | "none"
  | "bitrate_step_down"
  | "bitrate_step_up"
  | "unavailable";

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
  recoveryAttempts: number;
  recoveryAction: NetworkRecoveryAction;
  targetBitrateKbps: number;
}

interface NetworkRecoveryControllerDependencies {
  log: (message: string) => void;
  setMaxBitrateKbps: (kbps: number) => Promise<boolean>;
  onStateChange: (state: NetworkRecoveryState) => void;
  now?: () => number;
}

export interface NetworkRecoveryDecision {
  active: boolean;
  reason: string;
  desiredBitrateKbps: number;
}

const BAD_CONSECUTIVE_POLLS = 2;
const STABLE_CONSECUTIVE_POLLS = 20;
const DOWN_COOLDOWN_MS = 2_500;
const UP_COOLDOWN_MS = 30_000;
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
  private enabled = false;
  private active = false;
  private badConsecutivePolls = 0;
  private stableConsecutivePolls = 0;
  private recoveryAttempts = 0;
  private lastDownshiftAtMs = 0;
  private lastUpshiftAtMs = 0;
  private negotiatedMaxBitrateKbps = OFFICIAL_MIN_BITRATE_KBPS;
  private currentBitrateCeilingKbps = OFFICIAL_MIN_BITRATE_KBPS;
  private recoveryAction: NetworkRecoveryAction = "none";

  constructor(private readonly dependencies: NetworkRecoveryControllerDependencies) {}

  get targetBitrateKbps(): number {
    return this.enabled
      ? this.currentBitrateCeilingKbps
      : this.negotiatedMaxBitrateKbps;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    this.dependencies.log(`Network bitrate recovery ${enabled ? "enabled" : "disabled"}`);
    this.emitState();
  }

  initializeBitrate(maxBitrateKbps: number): void {
    this.negotiatedMaxBitrateKbps = Math.max(
      RECOVERY_MIN_BITRATE_KBPS,
      Math.floor(maxBitrateKbps),
    );
    this.currentBitrateCeilingKbps = this.negotiatedMaxBitrateKbps;
    this.active = false;
    this.badConsecutivePolls = 0;
    this.stableConsecutivePolls = 0;
    this.recoveryAttempts = 0;
    this.recoveryAction = "none";
    this.emitState();
  }

  reset(): void {
    this.active = false;
    this.badConsecutivePolls = 0;
    this.stableConsecutivePolls = 0;
    this.recoveryAttempts = 0;
    this.lastDownshiftAtMs = 0;
    this.lastUpshiftAtMs = 0;
    this.negotiatedMaxBitrateKbps = OFFICIAL_MIN_BITRATE_KBPS;
    this.currentBitrateCeilingKbps = OFFICIAL_MIN_BITRATE_KBPS;
    this.recoveryAction = "none";
    this.emitState();
  }

  async recover(sample: NetworkRecoverySample): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const decision = classifyNetworkRecoverySample(sample, this.negotiatedMaxBitrateKbps);
    if (decision.active) {
      this.stableConsecutivePolls = 0;
      this.badConsecutivePolls++;
      if (this.badConsecutivePolls < BAD_CONSECUTIVE_POLLS) {
        return;
      }
      await this.stepDown(decision);
      return;
    }

    this.badConsecutivePolls = 0;
    this.stableConsecutivePolls++;
    if (this.active && this.stableConsecutivePolls >= STABLE_CONSECUTIVE_POLLS) {
      await this.stepUp();
    }
  }

  private async stepDown(decision: NetworkRecoveryDecision): Promise<void> {
    const now = this.dependencies.now?.() ?? performance.now();
    if (now - this.lastDownshiftAtMs < DOWN_COOLDOWN_MS) {
      return;
    }
    const next = Math.min(this.currentBitrateCeilingKbps, decision.desiredBitrateKbps);
    if (next >= this.currentBitrateCeilingKbps) {
      this.active = true;
      this.emitState();
      return;
    }

    const updated = await this.dependencies.setMaxBitrateKbps(next);
    this.lastDownshiftAtMs = now;
    if (!updated) {
      this.active = true;
      this.recoveryAction = "unavailable";
      this.dependencies.log(
        `Network recovery wanted ${this.currentBitrateCeilingKbps} -> ${next} kbps (${decision.reason}), but live bitrate update is unavailable`,
      );
      this.emitState();
      return;
    }

    const previous = this.currentBitrateCeilingKbps;
    this.currentBitrateCeilingKbps = next;
    this.active = true;
    this.recoveryAttempts++;
    this.recoveryAction = "bitrate_step_down";
    this.dependencies.log(
      `Network recovery: bitrate ceiling stepped down ${previous} -> ${next} kbps (${decision.reason})`,
    );
    this.emitState();
  }

  private async stepUp(): Promise<void> {
    const now = this.dependencies.now?.() ?? performance.now();
    if (now - this.lastUpshiftAtMs < UP_COOLDOWN_MS) {
      return;
    }
    if (this.currentBitrateCeilingKbps >= this.negotiatedMaxBitrateKbps) {
      this.active = false;
      this.recoveryAction = "none";
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
      this.recoveryAction = "unavailable";
      this.emitState();
      return;
    }

    const previous = this.currentBitrateCeilingKbps;
    this.currentBitrateCeilingKbps = next;
    this.active = next < this.negotiatedMaxBitrateKbps;
    this.recoveryAction = "bitrate_step_up";
    this.dependencies.log(
      `Network recovery: bitrate ceiling stepped up ${previous} -> ${next} kbps`,
    );
    this.emitState();
  }

  private emitState(): void {
    this.dependencies.onStateChange({
      enabled: this.enabled,
      active: this.active,
      recoveryAttempts: this.recoveryAttempts,
      recoveryAction: this.recoveryAction,
      targetBitrateKbps: this.targetBitrateKbps,
    });
  }
}
