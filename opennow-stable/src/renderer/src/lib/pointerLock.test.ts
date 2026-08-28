import test from "node:test";
import assert from "node:assert/strict";

import {
  canForwardStreamPointerInput,
  didStreamPointerLockExit,
  getStreamPointerLockTarget,
  isStreamPointerLocked,
  resolveAutomaticCursorRelock,
} from "./pointerLock";

test("stream pointer lock accepts the video wrapper used by input capture", () => {
  const wrapper = {} as HTMLElement;
  const video = { parentElement: wrapper } as HTMLVideoElement;

  assert.equal(getStreamPointerLockTarget(video), wrapper);
  assert.equal(isStreamPointerLocked(video, wrapper), true);
  assert.equal(isStreamPointerLocked(video, video), true);
  assert.equal(isStreamPointerLocked(video, null), false);
});

test("stream pointer lock falls back to the video without a wrapper", () => {
  const video = { parentElement: null } as HTMLVideoElement;

  assert.equal(getStreamPointerLockTarget(video), video);
  assert.equal(isStreamPointerLocked(video, video), true);
});

test("unlocked pointer input only continues during the Escape fallback", () => {
  assert.equal(canForwardStreamPointerInput(true, false, false), true);
  assert.equal(canForwardStreamPointerInput(false, true, true), true);
  assert.equal(canForwardStreamPointerInput(false, true, false), false);
  assert.equal(canForwardStreamPointerInput(false, false, true), false);
});

test("pointer lock loss only fires on an active-to-inactive transition", () => {
  assert.equal(didStreamPointerLockExit(true, false), true);
  assert.equal(didStreamPointerLockExit(false, false), false);
  assert.equal(didStreamPointerLockExit(true, true), false);
  assert.equal(didStreamPointerLockExit(false, true), false);
});

test("cursor relock waits until both recovered video and input control are ready", () => {
  assert.equal(resolveAutomaticCursorRelock({
    armed: true,
    streamActive: true,
    videoReady: true,
    inputReady: false,
    pointerLocked: false,
  }), "wait");
  assert.equal(resolveAutomaticCursorRelock({
    armed: true,
    streamActive: true,
    videoReady: false,
    inputReady: true,
    pointerLocked: false,
  }), "wait");
});

test("cursor relock preserves an existing lock or restores a lost one after recovery", () => {
  assert.equal(resolveAutomaticCursorRelock({
    armed: true,
    streamActive: true,
    videoReady: true,
    inputReady: true,
    pointerLocked: true,
  }), "preserved");
  assert.equal(resolveAutomaticCursorRelock({
    armed: true,
    streamActive: true,
    videoReady: true,
    inputReady: true,
    pointerLocked: false,
  }), "restore");
});
