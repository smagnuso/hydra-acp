import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    daemon: "src/daemon-entry.ts",
  },
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  splitting: false,
  shims: false,
  minify: true,
});
