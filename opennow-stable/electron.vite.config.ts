import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const rendererStylesPath = resolve("src/renderer/src/styles.css");
const consoleStylesPath = resolve("src/renderer/src/styles/console.css");

function inlinePackagedRendererStyles() {
  return {
    name: "opennow-inline-packaged-renderer-styles",
    transformIndexHtml: {
      order: "post" as const,
      handler(html: string): string {
        const rendererStyles = readFileSync(rendererStylesPath, "utf8")
          .replace(/^@import\s+["']\.\/styles\/console\.css["'];\s*/u, "");
        const completeStyles = `${readFileSync(consoleStylesPath, "utf8")}\n${rendererStyles}`;

        // A raw, unstyled renderer is worse than a failed build. Keep the
        // complete stylesheet in index.html itself so a packaged file:// app
        // does not depend on a secondary CSS asset or runtime JS injection.
        if (completeStyles.length < 250_000 || !completeStyles.includes(".app-container")) {
          throw new Error("OpenNOW renderer stylesheet is incomplete; refusing to package an unstyled app.");
        }

        const inlineStyles = [
          '<style id="opennow-packaged-styles" data-opennow-critical="true">',
          completeStyles,
          "</style>",
        ].join("\n");

        if (!html.includes("</head>")) {
          throw new Error("OpenNOW renderer HTML has no </head>; cannot embed critical styles.");
        }

        return html.replace("</head>", `${inlineStyles}\n</head>`);
      },
    },
  };
}

function readBuildMetadata(): Record<string, string> {
  return {
    __OPENNOW_BUILD_NUMBER__: JSON.stringify(
      process.env.OPENNOW_BUILD_NUMBER?.trim()
      || process.env.BUILD_NUMBER?.trim()
      || process.env.GITHUB_RUN_NUMBER?.trim()
      || "",
    ),
    __OPENNOW_BUILD_COMMIT__: JSON.stringify(
      process.env.OPENNOW_BUILD_COMMIT?.trim()
      || process.env.GITHUB_SHA?.trim()
      || "",
    ),
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: readBuildMetadata(),
    build: {
      outDir: "dist-electron/main",
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist-electron/preload",
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  renderer: {
    build: {
      outDir: "dist",
    },
    plugins: [react(), inlinePackagedRendererStyles()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
});
