import { fileURLToPath } from "node:url"

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default {
  alias: {
    "@flamecast/harness/infer": source("./packages/harness/src/infer.ts"),
    "@flamecast/core": source("./packages/core/src/index.ts"),
    "@flamecast/evolve": source("./packages/evolve/src/index.ts"),
    "@flamecast/harness": source("./packages/harness/src/index.ts")
  },
  entry: {
    core: "packages/core/src/index.ts",
    harness: "packages/harness/src/index.ts",
    "runtime-memory": "packages/runtime-memory/src/index.ts",
    evolve: "packages/evolve/src/index.ts"
  },
  format: "esm",
  platform: "neutral",
  target: "es2023",
  tsconfig: "tsconfig.build.json",
  dts: true,
  deps: {
    alwaysBundle: [/^@flamecast\//],
    neverBundle: ["effect"]
  }
}
