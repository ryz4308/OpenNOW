/// <reference types="node" />

import test from "node:test";
import assert from "node:assert/strict";

import { estimateQueueWait, formatQueueWaitEstimate } from "./queueWaitEstimator";

test("uses a conservative fallback before the queue starts moving", () => {
  const estimate = estimateQueueWait({
    position: 36,
    activeElapsedSeconds: 0,
    observations: [{ activeElapsedSeconds: 0, position: 36 }],
  });
  assert.equal(estimate?.confidence, "fallback");
  assert.equal(estimate?.secondsPerPosition, 25);
  assert.equal(formatQueueWaitEstimate(estimate!.remainingSeconds), "~15 min");
});

test("calibrates from actual position changes and discounts an outlier", () => {
  const estimate = estimateQueueWait({
    position: 16,
    activeElapsedSeconds: 130,
    persistedSecondsPerPosition: 25,
    observations: [
      { activeElapsedSeconds: 0, position: 30 },
      { activeElapsedSeconds: 100, position: 20 },
      { activeElapsedSeconds: 102, position: 19 },
      { activeElapsedSeconds: 130, position: 16 },
    ],
  });
  assert.equal(estimate?.confidence, "measured");
  assert.ok(estimate!.secondsPerPosition >= 10);
  assert.ok(estimate!.secondsPerPosition < 20);
});

test("does not treat a queue-position increase as completed capacity", () => {
  const estimate = estimateQueueWait({
    position: 22,
    activeElapsedSeconds: 30,
    persistedSecondsPerPosition: 40,
    observations: [
      { activeElapsedSeconds: 0, position: 20 },
      { activeElapsedSeconds: 30, position: 22 },
    ],
  });
  assert.equal(estimate?.clearedPositions, 0);
  assert.equal(estimate?.secondsPerPosition, 40);
});

test("formats minute and hour estimates compactly", () => {
  assert.equal(formatQueueWaitEstimate(30), "<1 min");
  assert.equal(formatQueueWaitEstimate(360), "~6 min");
  assert.equal(formatQueueWaitEstimate(4_020), "~1h 7m");
});
