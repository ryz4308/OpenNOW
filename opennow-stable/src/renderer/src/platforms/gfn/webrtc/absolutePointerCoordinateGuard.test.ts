/// <reference types="node" />

import test from "node:test";
import assert from "node:assert/strict";

import { mapAbsolutePointerToLogicalExtent } from "./absolutePointerCoordinateGuard";

test("maps a CSS viewport into a stable logical remote desktop", () => {
  assert.deepEqual(
    mapAbsolutePointerToLogicalExtent(
      { x: 2, y: 3, width: 4, height: 4 },
      { width: 1920, height: 1080 },
    ),
    { x: 960, y: 810, width: 1920, height: 1080 },
  );
});

test("clamps coordinates and rejects invalid extents safely", () => {
  assert.deepEqual(
    mapAbsolutePointerToLogicalExtent(
      { x: 200, y: -5, width: 100, height: 50 },
      { width: 1280, height: 720 },
    ),
    { x: 1280, y: 0, width: 1280, height: 720 },
  );
});
