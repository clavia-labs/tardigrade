import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    core: "packages/core/src/index.ts",
    harness: "packages/harness/src/index.ts",
    "runtime-memory": "packages/runtime-memory/src/index.ts",
    evolve: "packages/evolve/src/index.ts"
  },
  format: "esm",
  platform: "neutral",
  target: "es2023",
  dts: true,
  deps: {
    alwaysBundle: [/^@flamecast\//],
    neverBundle: ["effect"]
  }
})
