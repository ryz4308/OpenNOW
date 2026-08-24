import { Cpu, Monitor, Radio, Wifi, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, Ref } from "react";
import { m, useReducedMotion } from "motion/react";
import {
  getPreferredSessionAdMediaUrl,
  getSessionAdItems,
  getSessionAdMessage,
  isSessionAdsRequired,
  isSessionQueuePaused,
} from "@shared/gfn";
import type { SessionAdInfo, SessionAdState } from "@shared/gfn";
import { getStoreDisplayName, getStoreIconComponent } from "./GameCard";
import { QueueAdPreview, type QueueAdPlaybackEvent, type QueueAdPreviewHandle } from "./QueueAdPreview";
import { LazyShaderAtmosphere } from "./LazyShaderAtmosphere";
import { useTranslation } from "../i18n";
import { getStatusPulseMotion } from "./MotionProvider";
import {
  estimateQueueWait,
  formatQueueWaitEstimate,
  type QueuePositionObservation,
} from "../utils/queueWaitEstimator";

type TranslateFunction = typeof import("../i18n").t;

const launchStages = [
  { id: "queue", icon: Radio },
  { id: "setup", icon: Cpu },
  { id: "connecting", icon: Wifi },
  { id: "ready", icon: Monitor },
] as const;

export interface StreamLoadingProps {
  gameTitle: string;
  gameCover?: string;
  platformStore?: string;
  status: "queue" | "setup" | "starting" | "connecting";
  queuePosition?: number;
  estimatedWait?: string;
  queueEstimateKey?: string;
  adState?: SessionAdState;
  activeAd?: SessionAdInfo;
  activeAdMediaUrl?: string;
  error?: {
    title: string;
    description: string;
    code?: string;
    actionLabel?: string;
  };
  onAdPlaybackEvent?: (event: QueueAdPlaybackEvent, adId: string) => void;
  adPreviewRef?: Ref<QueueAdPreviewHandle>;
  onErrorAction?: () => void;
  onCancel: () => void;
}

function getStatusMessage(
  t: TranslateFunction,
  status: StreamLoadingProps["status"],
  queuePosition?: number,
  adState?: SessionAdState,
  isError = false,
): string {
  if (isError) return t("streamLoading.status.gameLaunchFailed");
  if (isSessionQueuePaused(adState)) return t("streamLoading.status.queuePaused");

  switch (status) {
    case "queue":
      return queuePosition
        ? t("streamLoading.status.positionInQueue", { position: queuePosition })
        : t("streamLoading.status.waitingInQueue");
    case "setup":
      return t("streamLoading.status.settingUpRig");
    case "starting":
      return t("streamLoading.status.startingStream");
    case "connecting":
      return t("streamLoading.status.connectingToServer");
  }
}

function getPhaseDetail(t: TranslateFunction, status: StreamLoadingProps["status"]): string {
  switch (status) {
    case "queue":
      return t("streamLoading.cozy.queue");
    case "setup":
      return t("streamLoading.cozy.setup");
    case "starting":
      return t("streamLoading.cozy.starting");
    case "connecting":
      return t("streamLoading.cozy.connecting");
  }
}

function getNextStep(t: TranslateFunction, status: StreamLoadingProps["status"]): string {
  switch (status) {
    case "queue":
      return t("streamLoading.steps.setup");
    case "setup":
      return t("streamLoading.status.startingStream");
    case "starting":
      return t("streamLoading.steps.connect");
    case "connecting":
      return t("streamLoading.steps.ready");
  }
}

function getActiveStage(status: StreamLoadingProps["status"]): number {
  if (status === "queue") return 0;
  if (status === "setup") return 1;
  return 2;
}

function formatWaitTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function getAdSummary(t: TranslateFunction, adState?: SessionAdState): string | null {
  if (!isSessionAdsRequired(adState)) return null;
  const message = getSessionAdMessage(adState);
  if (message) return message;
  if (isSessionQueuePaused(adState)) return t("streamLoading.ads.resumeToStayInQueue");
  const ads = getSessionAdItems(adState);
  return ads.length > 0
    ? t("streamLoading.ads.availableForProgression", { count: ads.length })
    : t("streamLoading.ads.playbackRequired");
}

export function StreamLoading({
  gameTitle,
  gameCover,
  platformStore,
  status,
  queuePosition,
  estimatedWait,
  queueEstimateKey = "default",
  adState,
  activeAd,
  activeAdMediaUrl,
  error,
  onAdPlaybackEvent,
  adPreviewRef,
  onErrorAction,
  onCancel,
}: StreamLoadingProps): JSX.Element {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const statusPulseMotion = getStatusPulseMotion(reducedMotion);
  const [startedAt] = useState(() => Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [activeQueueSeconds, setActiveQueueSeconds] = useState(0);
  const [queueObservations, setQueueObservations] = useState<QueuePositionObservation[]>([]);
  const [persistedQueueRate, setPersistedQueueRate] = useState<number | null>(null);
  const lastTimerAtRef = useRef(Date.now());
  const lastPersistedClearedRef = useRef(0);
  const hasError = Boolean(error);
  const statusMessage = getStatusMessage(t, status, queuePosition, adState, hasError);
  const platformName = platformStore ? getStoreDisplayName(platformStore) : "";
  const PlatformIcon = platformStore ? getStoreIconComponent(platformStore) : null;
  const adSummary = getAdSummary(t, adState);
  const cachedAdMediaUrl = activeAdMediaUrl ?? getPreferredSessionAdMediaUrl(activeAd);
  const activeStage = getActiveStage(status);
  const queuePaused = isSessionQueuePaused(adState);

  useEffect(() => {
    const storageKey = `opennow.queue-rate.v1.${queueEstimateKey}`;
    try {
      const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as {
        secondsPerPosition?: number;
        updatedAt?: number;
      } | null;
      const isFresh = stored?.updatedAt && Date.now() - stored.updatedAt < 14 * 24 * 60 * 60 * 1000;
      setPersistedQueueRate(isFresh && Number.isFinite(stored?.secondsPerPosition)
        ? stored!.secondsPerPosition!
        : null);
    } catch {
      setPersistedQueueRate(null);
    }
    setQueueObservations([]);
    setActiveQueueSeconds(0);
    lastPersistedClearedRef.current = 0;
  }, [queueEstimateKey]);

  useEffect(() => {
    if (hasError) return undefined;
    lastTimerAtRef.current = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const deltaSeconds = Math.max(0, (now - lastTimerAtRef.current) / 1000);
      lastTimerAtRef.current = now;
      setElapsedSeconds(Math.floor((now - startedAt) / 1000));
      if (status === "queue" && !queuePaused) {
        setActiveQueueSeconds((value) => value + deltaSeconds);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasError, queuePaused, startedAt, status]);

  useEffect(() => {
    if (status !== "queue" || !queuePosition || queuePosition < 1) return;
    setQueueObservations((current) => {
      const last = current.at(-1);
      if (last?.position === queuePosition) return current;
      const next = { activeElapsedSeconds: activeQueueSeconds, position: queuePosition };
      if (last && queuePosition > last.position) return [next];
      return [...current, next].slice(-40);
    });
  }, [activeQueueSeconds, queuePosition, status]);

  const queueWaitEstimate = useMemo(() => {
    if (status !== "queue" || !queuePosition) return null;
    return estimateQueueWait({
      position: queuePosition,
      activeElapsedSeconds: activeQueueSeconds,
      observations: queueObservations,
      persistedSecondsPerPosition: persistedQueueRate,
    });
  }, [activeQueueSeconds, persistedQueueRate, queueObservations, queuePosition, status]);

  useEffect(() => {
    if (!queueWaitEstimate || queueWaitEstimate.clearedPositions < 3) return;
    if (queueWaitEstimate.clearedPositions <= lastPersistedClearedRef.current) return;
    lastPersistedClearedRef.current = queueWaitEstimate.clearedPositions;
    const blendedRate = persistedQueueRate === null
      ? queueWaitEstimate.secondsPerPosition
      : persistedQueueRate * 0.75 + queueWaitEstimate.secondsPerPosition * 0.25;
    setPersistedQueueRate(blendedRate);
    try {
      window.localStorage.setItem(`opennow.queue-rate.v1.${queueEstimateKey}`, JSON.stringify({
        secondsPerPosition: blendedRate,
        updatedAt: Date.now(),
      }));
    } catch {
      // The live estimate still works when storage is disabled.
    }
  }, [persistedQueueRate, queueEstimateKey, queueWaitEstimate]);

  const queueWaitText = status === "queue"
    ? estimatedWait
      ? `~${estimatedWait}`
      : queueWaitEstimate
        ? formatQueueWaitEstimate(queueWaitEstimate.remainingSeconds)
        : t("streamLoading.telemetry.calculating")
    : t("streamLoading.telemetry.cleared");

  return (
    <div className={`sload${hasError ? " sload--error" : ""}`}>
      <div className="sload-backdrop" />
      {!hasError && <LazyShaderAtmosphere variant={status === "queue" ? "queue" : "connecting"} />}
      <div className="sload-backdrop-wash" />

      <div className="sload-content">
        <div className="sload-game">
          <div className="sload-cover">
            {gameCover ? (
              <img src={gameCover} alt="" className="sload-cover-img" />
            ) : (
              <div className="sload-cover-empty"><Monitor size={24} /></div>
            )}
          </div>
          <div className="sload-game-meta">
            <p className="sload-label">{hasError ? t("streamLoading.labels.launchError") : t("streamLoading.labels.nowLoading")}</p>
            <h2 className="sload-title" title={gameTitle}>{gameTitle}</h2>
            {PlatformIcon && (
              <div className="sload-platform" title={platformName}>
                <span className="sload-platform-icon"><PlatformIcon /></span>
                <span>{platformName}</span>
              </div>
            )}
          </div>
        </div>

        {!hasError && (
          <div className="sload-stage-rail" aria-label={t("streamLoading.labels.launchProgress")}>
            {launchStages.map((stage, index) => {
              const StageIcon = stage.icon;
              const state = index < activeStage ? "completed" : index === activeStage ? "active" : "pending";
              return (
                <div className={`sload-stage sload-stage--${state}`} key={stage.id}>
                  <m.span
                    className="sload-stage-icon"
                    animate={state === "active"
                      ? statusPulseMotion.animate
                      : { opacity: 1, scale: 1 }}
                    transition={state === "active"
                      ? statusPulseMotion.transition
                      : { duration: 0.2 }}
                  >
                    <StageIcon size={18} />
                  </m.span>
                  {index < launchStages.length - 1 && <span className="sload-stage-line" />}
                </div>
              );
            })}
          </div>
        )}

        <div className={`sload-status${hasError ? " sload-status--error" : ""}`}>
          {hasError ? (
            <XCircle size={24} className="sload-error-icon" />
          ) : (
            <m.span
              className="sload-live-dot"
              aria-hidden="true"
              animate={statusPulseMotion.animate}
              transition={statusPulseMotion.transition}
            />
          )}
          <div className="sload-status-text">
            <p className="sload-message" role="status" aria-live="polite">{statusMessage}</p>
            {!hasError && <p className="sload-detail">{getPhaseDetail(t, status)}</p>}
            {hasError && error && (
              <>
                <p className="sload-error-title">{error.title}</p>
                <p className="sload-error-desc">{error.description}</p>
                {error.code && <p className="sload-error-code">{error.code}</p>}
              </>
            )}
          </div>
        </div>

        {!hasError && (
          <div className="sload-facts">
            <div className="sload-fact">
              <p>{t("streamLoading.telemetry.queuePosition")}</p>
              <strong>{status === "queue" && queuePosition ? `#${queuePosition}` : status === "queue" ? t("streamLoading.telemetry.calculating") : t("streamLoading.telemetry.cleared")}</strong>
            </div>
            <div className="sload-fact">
              <p>{t("streamLoading.telemetry.elapsed")}</p>
              <strong>{formatWaitTime(elapsedSeconds)}</strong>
            </div>
            <div className="sload-fact">
              <p>{t("streamLoading.telemetry.estimatedLeft")}</p>
              <strong>{queueWaitText}</strong>
            </div>
            <div className="sload-fact">
              <p>{t("streamLoading.cozy.next")}</p>
              <strong>{getNextStep(t, status)}</strong>
            </div>
          </div>
        )}

        {!hasError && activeAd && cachedAdMediaUrl && (
          <div className={`sload-ad${isSessionQueuePaused(adState) ? " sload-ad--paused" : ""}`}>
            <div className="sload-ad-copy">
              <span className="sload-ad-chip">{t("streamLoading.labels.adQueue")}</span>
              {adSummary && <p className="sload-ad-message">{adSummary}</p>}
            </div>
            <div className="sload-ad-media">
              <QueueAdPreview
                ref={adPreviewRef}
                mediaUrl={cachedAdMediaUrl}
                title={activeAd.title}
                onPlaybackEvent={(event) => onAdPlaybackEvent?.(event, activeAd.adId)}
              />
            </div>
          </div>
        )}

        <div className="sload-actions">
          {hasError && error?.actionLabel && onErrorAction && (
            <button className="sload-cancel sload-cancel--primary" onClick={onErrorAction}>
              <span>{error.actionLabel}</span>
            </button>
          )}
          <button className="sload-cancel" onClick={onCancel} aria-label={t("streamLoading.actions.cancelLoading")}>
            <X size={16} />
            <span>{hasError ? t("app.actions.close") : t("app.actions.cancel")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
