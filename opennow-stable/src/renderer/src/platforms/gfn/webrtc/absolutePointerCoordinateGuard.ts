export interface AbsolutePointerPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LogicalPointerExtent {
  width: number;
  height: number;
}

/**
 * Converts an unlocked browser pointer from the current CSS viewport into the
 * stable logical desktop advertised when the GFN session was created.
 *
 * Adaptive stream resolution changes must never change the remote pointer
 * coordinate space: a temporary 960x540 frame is still displayed on (and
 * controlled as) the requested 1920x1080 desktop.
 */
export function mapAbsolutePointerToLogicalExtent(
  position: AbsolutePointerPosition,
  logicalExtent: LogicalPointerExtent,
): AbsolutePointerPosition {
  const localWidth = positiveFinite(position.width, 1);
  const localHeight = positiveFinite(position.height, 1);
  const logicalWidth = positiveFinite(logicalExtent.width, localWidth);
  const logicalHeight = positiveFinite(logicalExtent.height, localHeight);
  const normalizedX = clamp(position.x / localWidth, 0, 1);
  const normalizedY = clamp(position.y / localHeight, 0, 1);

  return {
    x: normalizedX * logicalWidth,
    y: normalizedY * logicalHeight,
    width: logicalWidth,
    height: logicalHeight,
  };
}

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
