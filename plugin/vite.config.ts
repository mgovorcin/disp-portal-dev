import { defineConfig } from "vite";
import { resolve } from "node:path";

// Builds the GeoLibre bundle: geolibre-plugin/{plugin.json, dist/index.js, dist/style.css}.
// maplibre-gl is only used for types; the plugin drives the host's map instance.
export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/geolibre.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    outDir: "geolibre-plugin/dist",
    emptyOutDir: true,
    rollupOptions: { output: { assetFileNames: () => "style.css" } },
    cssCodeSplit: false,
    sourcemap: false,
    minify: false,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});
