import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import { extractFile } from "@electron/asar";

const target = resolve(process.argv[2] || "dist/index.html");
const html = extname(target) === ".asar"
  ? extractFile(target, "dist/index.html").toString("utf8")
  : readFileSync(target, "utf8");

const requiredMarkers = [
  'id="opennow-packaged-styles"',
  'data-opennow-critical="true"',
  ".app-container",
  "--accent-rgb: 88, 217, 138",
  "CONSOLE MODE",
];
const missingMarkers = requiredMarkers.filter((marker) => !html.includes(marker));

if (Buffer.byteLength(html) < 250_000 || missingMarkers.length > 0) {
  throw new Error([
    `Packaged renderer styles are incomplete in ${target}.`,
    `HTML bytes: ${Buffer.byteLength(html)}.`,
    `Missing markers: ${missingMarkers.join(", ") || "none"}.`,
  ].join(" "));
}

console.log(`Verified packaged renderer CSS in ${target} (${Buffer.byteLength(html)} HTML bytes).`);
