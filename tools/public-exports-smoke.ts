import { createRequire } from "node:module"
import { join } from "node:path"

const require = createRequire(join(process.cwd(), "package.json"))
const load = (path: string): Promise<Record<string, unknown>> => import(require.resolve(path))
const core = await load("tardie/core")
const agent = await load("tardie/agent")
const services = await load("tardie/agent/services")
const libraries = await load("tardie/libraries")
const legacy = await load("tardie/deprecated")
for (const [scope, name] of [[core, "defineActor"], [core, "createEventLog"], [core, "initialiseState"], [libraries, "defineLibrary"], [legacy, "actor"]] as const) {
  if (typeof scope[name] !== "function") throw new Error(`Missing public API ${name}`)
}
if (!("messages" in agent) || "conversation" in agent) throw new Error("Agent message projection exports failed")
if (typeof agent.createActor !== "object") throw new Error("Missing agent actor definition")
if (Object.keys(services).length === 0) throw new Error("Agent services entrypoint is empty")
await load("tardie/platform/bun")
await load("tardie/deprecated/bun")
await load("tardie/deprecated/client")
await load("tardie/model")
await load("tardie/code")
for (const path of ["tardie", "tardie/experimental", "tardie/core/atoms/atom", "tardie/agent/atoms", "tardie/deprecated/core/component/runtime", "tardie/deprecated/core/component/composition/parent"]) {
  let blocked = false
  try { require.resolve(path) } catch { blocked = true }
  if (!blocked) throw new Error(`${path} is publicly importable`)
}
console.log("Public package imports and private boundaries passed")
