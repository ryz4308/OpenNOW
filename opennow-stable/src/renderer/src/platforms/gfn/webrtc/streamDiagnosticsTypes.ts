import type { NativeQueueMode } from "@shared/gfn";
import type { MicState } from "../microphoneManager";
import type { NetworkRecoveryPhase } from "./networkRecoveryController";

export interface StreamDiagnostics {
  // Connection state
  connectionState: RTCPeerConnectionState | "closed";
  inputReady: boolean;
  nativeRendererActive: boolean;
  connectedGamepads: number;

  // Video stats
  resolution: string;
  codec: string;
  requestedCodec: string;
  hardwareAcceleration: string;
  colorCodec: string;
  isHdr: boolean;
  bitrateKbps: number;
  targetBitrateKbps: number;
  availableBitrateKbps: number;
  decodeFps: number;
  receiveFps: number;
  renderFps: number;
  gameFps?: number;

  // Network stats
  packetsLost: number;
  packetsReceived: number;
  packetLossPercent: number;
  jitterMs: number;
  rttMs: number;
  transportType: "udp" | "tcp" | "unknown";
  localCandidateType: string;
  remoteCandidateType: string;
  iceConnectionState: RTCIceConnectionState | "closed";
  signalingState: RTCSignalingState | "closed";
  dataChannels: string[];

  // Frame counters
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  keyFramesDecoded: number;
  nackCount: number;
  pliCount: number;
  firCount: number;
  freezeCount: number;
  totalFreezesDurationMs: number;

  // Timing
  decodeTimeMs: number;
  renderTimeMs: number;
  jitterBufferDelayMs: number;

  // Input channel pressure
  inputQueueBufferedBytes: number;
  inputQueuePeakBufferedBytes: number;
  partiallyReliableInputQueueBufferedBytes: number;
  partiallyReliableInputQueuePeakBufferedBytes: number;
  inputQueueDropCount: number;
  inputQueueMaxSchedulingDelayMs: number;
  partiallyReliableInputOpen: boolean;
  mouseMoveTransport: "reliable" | "partially_reliable";
  mouseFlushIntervalMs: number;
  mousePacketsPerSecond: number;
  mouseResidualMagnitude: number;
  mouseAdaptiveFlushActive: boolean;
  cursorOverlayVisible: boolean;
  cursorPointerLocked: boolean;
  cursorViewportWidth: number;
  cursorViewportHeight: number;
  cursorVideoRectWidth: number;
  cursorVideoRectHeight: number;
  cursorSourceWidth: number;
  cursorSourceHeight: number;
  cursorDevicePixelRatio: number;
  cursorViewportResyncCount: number;
  cursorViewportLastResyncReason: string;

  lagReason: StreamLagReason;
  lagReasonDetail: string;

  // System info
  gpuType: string;
  serverGpuType: string;
  sessionId: string;
  serverRegion: string;
  serverZone: string;
  serverLocation: string;

  // Decoder recovery status
  decoderPressureActive: boolean;
  decoderRecoveryAttempts: number;
  decoderRecoveryAction: string;
  networkRecoveryEnabled: boolean;
  networkRecoveryActive: boolean;
  networkRecoveryState: NetworkRecoveryPhase;
  networkRecoveryAttempts: number;
  networkRecoveryAction: string;
  networkRecoveryTargetBitrateKbps: number;
  nativeRequestedFps?: number;
  nativeCapsFramerate?: string;
  nativeQueueMode?: NativeQueueMode;
  nativeFramesPendingToPresent?: number;
  nativePartialFlushCount?: number;
  nativeCompleteFlushCount?: number;
  nativeTransitionSummary?: string;
  nativeRequestedStreamingFeaturesSummary?: string;
  nativeFinalizedStreamingFeaturesSummary?: string;

  // Microphone state
  micState: MicState;
  micEnabled: boolean;
}

export type StreamLagReason =
  | "unknown"
  | "stable"
  | "network"
  | "decoder"
  | "input_backpressure"
  | "render";

export interface StreamTimeWarning {
  code: 1 | 2 | 3;
  secondsLeft?: number;
}
