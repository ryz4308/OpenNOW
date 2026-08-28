export function getStreamPointerLockTarget(videoElement: HTMLVideoElement): HTMLElement {
  return (videoElement.parentElement as HTMLElement | null) ?? videoElement;
}

export function isStreamPointerLocked(
  videoElement: HTMLVideoElement,
  pointerLockElement: Element | null = document.pointerLockElement,
): boolean {
  return (
    pointerLockElement === videoElement
    || pointerLockElement === getStreamPointerLockTarget(videoElement)
  );
}

export function canForwardStreamPointerInput(
  pointerLocked: boolean,
  escapeFallbackActive: boolean,
  pointerInsideStream: boolean,
): boolean {
  return pointerLocked || (escapeFallbackActive && pointerInsideStream);
}

export function didStreamPointerLockExit(
  pointerLockWasActive: boolean,
  pointerLockIsActive: boolean,
): boolean {
  return pointerLockWasActive && !pointerLockIsActive;
}

export function resolveAutomaticCursorRelock(input: {
  armed: boolean;
  streamActive: boolean;
  videoReady: boolean;
  inputReady: boolean;
  pointerLocked: boolean;
}): "wait" | "preserved" | "restore" {
  if (!input.armed || !input.streamActive || !input.videoReady || !input.inputReady) {
    return "wait";
  }
  return input.pointerLocked ? "preserved" : "restore";
}
