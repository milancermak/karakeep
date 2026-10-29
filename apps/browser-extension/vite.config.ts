import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

import manifest from "./manifest.json";
import nightlyManifest from "./manifest.nightly.json";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    crx({
      manifest: process.env.KARAKEEP_EXTENSION_DEV
        ? {
            ...manifest,
            name: "Karakeep Dev",
            browser_specific_settings: {
              gecko: { id: "dev-x-capture@karakeep.local" },
            },
          }
        : process.env.KARAKEEP_EXTENSION_NIGHTLY
          ? {
              ...manifest,
              ...nightlyManifest,
              version:
                process.env.KARAKEEP_EXTENSION_VERSION ??
                nightlyManifest.version,
            }
          : manifest,
      browser: process.env.VITE_BUILD_FIREFOX ? "firefox" : "chrome",
      contentScripts: {
        // Injected on demand with `chrome.scripting.executeScript({ files })`,
        // which needs a self-contained classic script rather than crxjs's
        // default loader (it imports the real module asynchronously).
        standaloneFiles: [
          "src/content-scripts/singlefile-content-script.ts",
          "src/content-scripts/x-capture-entry.ts",
        ],
      },
    }),
  ],
  server: {
    port: 5174,
    strictPort: true,
    cors: {
      origin: [/chrome-extension:\/\//],
    },
  },
});
