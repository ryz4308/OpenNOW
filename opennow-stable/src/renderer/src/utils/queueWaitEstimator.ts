export interface QueuePositionObservation {
  activeElapsedSeconds: number;
  position: number;
}
export interface QueueWaitEstimate {
  remainingSeconds: number;
  secondsPerPosition: number;
  clearedPositions: number;
  confidence: "fallback" | "calibrating" | "measured";
}

const DEFAULT_SECONDS_PER_POSITION = 25;
const MIN_SECONDS_PER_POSITION = 2;
const MAX_SECONDS_PER_POSITION = 180;
const MAX_REMAINING_SECONDS = 12 * 60 * 60;

function clampRate(value: number): number {
  return Math.max(MIN_SECONDS_PER_POSITION, Math.min(MAX_SECONDS_PER_POSITION, value));
}

function weightedMedian(samples: Array<{ value: number; weight: number }>): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, sample) => sum + sample.weight, 0);
  let accumulated = 0;
  for (const sample of sorted) {
    accumulated += sample.weight;
    if (accumulated >= totalWeight / 2) return sample.value;
  }
  return sorted.at(-1)?.value ?? null;
}

/**
 * Estimate remaining queue time from real position changes in the current
 * session. A weighted median rejects one-off queue jumps/stalls better than a
 * simple average. A persisted per-zone rate makes the first estimate useful;
 * the live queue progressively replaces it after several positions clear.
 */
export function estimateQueueWait(params: {
  position: number;
  activeElapsedSeconds: number;
  observations: QueuePositionObservation[];
  persistedSecondsPerPosition?: number | null;
}): QueueWaitEstimate | null {
  const position = Math.max(1, Math.floor(params.position));
  if (!Number.isFinite(position)) return null;

  const observations = params.observations
    .filter((item) => Number.isFinite(item.position) && item.position > 0 && Number.isFinite(item.activeElapsedSeconds))
    .sort((a, b) => a.activeElapsedSeconds - b.activeElapsedSeconds);
  const rateSamples: Array<{ value: number; weight: number }> = [];
  let clearedPositions = 0;
  for (let index = 1; index < observations.length; index++) {
    const previous = observations[index - 1]!;
    const current = observations[index]!;
    const cleared = previous.position - current.position;
    const elapsed = current.activeElapsedSeconds - previous.activeElapsedSeconds;
    if (cleared <= 0 || elapsed <= 0) continue;
    const rate = elapsed / cleared;
    if (rate < MIN_SECONDS_PER_POSITION || rate > MAX_SECONDS_PER_POSITION) continue;
    clearedPositions += cleared;
    rateSamples.push({
      value: rate,
      weight: Math.min(12, cleared) * (1 + index / Math.max(1, observations.length)),
    });
  }

  const liveRate = weightedMedian(rateSamples);
  const persistedRate = Number.isFinite(params.persistedSecondsPerPosition)
    ? clampRate(params.persistedSecondsPerPosition!)
    : DEFAULT_SECONDS_PER_POSITION;
  const liveWeight = liveRate === null ? 0 : Math.min(0.9, clearedPositions / 15);
  const secondsPerPosition = clampRate(
    liveRate === null
      ? persistedRate
      : persistedRate * (1 - liveWeight) + liveRate * liveWeight,
  );

  const lastObservationAt = observations.at(-1)?.activeElapsedSeconds ?? 0;
  const phaseElapsed = Math.max(0, params.activeElapsedSeconds - lastObservationAt);
  // Count down most of one expected queue step, then hold instead of claiming
  // zero while a queue is temporarily stalled or capacity is being allocated.
  const phaseCredit = Math.min(phaseElapsed, secondsPerPosition * 0.9);
  const seatsAhead = Math.max(0, position - 1);
  const setupBuffer = Math.max(15, Math.min(45, secondsPerPosition));
  const remainingSeconds = Math.max(
    setupBuffer,
    Math.min(MAX_REMAINING_SECONDS, seatsAhead * secondsPerPosition + setupBuffer - phaseCredit),
  );

  return {
    remainingSeconds,
    secondsPerPosition,
    clearedPositions,
    confidence: clearedPositions >= 8 ? "measured" : clearedPositions > 0 ? "calibrating" : "fallback",
  };
}

export function formatQueueWaitEstimate(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "<1 min";
  if (totalSeconds < 60) return "<1 min";
  const roundedMinutes = Math.max(1, Math.round(totalSeconds / 60));
  if (roundedMinutes < 60) return `~${roundedMinutes} min`;
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  return minutes > 0 ? `~${hours}h ${minutes}m` : `~${hours}h`;
}
