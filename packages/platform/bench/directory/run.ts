import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { build } from "esbuild"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { DIRECTORY_ORACLE_DEFAULTS as defaults, DIRECTORY_ORACLE_ACTOR, DIRECTORY_ORACLE_INSTANCE, type JournalStats } from "./config.ts"
import { directoryInspector, type HeapUsage } from "./inspector.ts"

const root = fileURLToPath(new URL("../../../../", import.meta.url))
const { values } = parseArgs({ options: {
  mode: { type: "string", default: "candidate" },
  small: { type: "string", default: String(defaults.smallThreads) },
  large: { type: "string", default: String(defaults.largeThreads) },
  "payload-bytes": { type: "string", default: String(defaults.payloadBytes) },
  pending: { type: "string", default: String(defaults.pendingThreads) },
  "seed-batch": { type: "string", default: String(defaults.seedBatchSize) },
  lookups: { type: "string", default: String(defaults.lookupCount) },
  fresh: { type: "string", default: String(defaults.freshThreads) },
  "sample-ms": { type: "string", default: String(defaults.sampleIntervalMs) },
  "timeout-ms": { type: "string", default: String(defaults.requestTimeoutMs) },
  "poll-ms": { type: "string", default: String(defaults.pollIntervalMs) },
  "max-peak-mib": { type: "string", default: String(defaults.maxPeakBytes / 2 ** 20) },
  "max-retained-mib": { type: "string", default: String(defaults.maxRetainedBytes / 2 ** 20) },
  "max-growth-mib": { type: "string", default: String(defaults.maxRetainedGrowthBytes / 2 ** 20) },
  "max-backing-mib": { type: "string", default: String(defaults.maxBackingBytes / 2 ** 20) },
  out: { type: "string", default: join(root, ".experiments/directory-oracle", new Date().toISOString().replaceAll(":", "-")) },
} })
const integer = (key: keyof typeof values, minimum = 1) => {
  const value = Number(values[key])
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${key} must be an integer >= ${minimum}`)
  return value
}
const bytes = (key: keyof typeof values) => {
  const value = Number(values[key]) * 2 ** 20
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must specify a nonnegative whole number of bytes in MiB`)
  return value
}
const config = {
  mode: values.mode,
  smallThreads: integer("small"), largeThreads: integer("large"), payloadBytes: integer("payload-bytes", 0),
  pendingThreads: integer("pending"), seedBatchSize: integer("seed-batch"), lookupCount: integer("lookups", 2), freshThreads: integer("fresh", 2),
  sampleIntervalMs: integer("sample-ms"), requestTimeoutMs: integer("timeout-ms"), pollIntervalMs: integer("poll-ms"),
  maxPeakBytes: bytes("max-peak-mib"), maxRetainedBytes: bytes("max-retained-mib"), maxRetainedGrowthBytes: bytes("max-growth-mib"),
  maxBackingBytes: bytes("max-backing-mib"),
}
if (config.mode !== "candidate" && config.mode !== "control") throw new Error("mode must be candidate or control")
if (config.largeThreads <= config.smallThreads) throw new Error("large must exceed small")
const out = resolve(values.out)
await mkdir(out, { recursive: true })
const bundle = join(out, "worker.mjs")
await build({ entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))], outfile: bundle, bundle: true, format: "esm", platform: "neutral", target: "es2024", conditions: ["workerd", "worker", "browser", "import"], mainFields: ["module", "main"], external: ["node:*", "cloudflare:*"], sourcemap: "external", sourcesContent: false })
const main = join(out, "main.mjs")
await writeFile(main, 'export { DirectoryDO, ThreadDO, default } from "./worker.mjs"\n')
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const coordinate = (thread: string) => ({ actor: DIRECTORY_ORACLE_ACTOR, instance: DIRECTORY_ORACLE_INSTANCE, thread })

interface Phase {
  readonly name: string
  readonly elapsedMs: number
  readonly samples: number
  readonly peakBytes: number
  readonly peakBackingBytes: number
  readonly retainedBytes?: number
  readonly before: HeapUsage
  readonly after?: HeapUsage
  readonly error?: string
}
interface Scenario {
  readonly threads: number
  readonly phases: Phase[]
  readonly failures: string[]
  seed?: JournalStats
  prefixAfter?: JournalStats
  peakBytes?: number
  peakBackingBytes?: number
  retainedBytes?: number
}
const scenarios: Scenario[] = []
const require = createRequire(import.meta.url)
const version = (name: string) => (require(`${name}/package.json`) as { version: string }).version
const workerdVersion = (createRequire(require.resolve("miniflare"))("workerd/package.json") as { version: string }).version
const oracleHash = createHash("sha256")
for (const file of ["run.ts", "inspector.ts", "config.ts"]) oracleHash.update(await readFile(new URL(file, import.meta.url)))
const source = { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), status: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }), bundleSha256: createHash("sha256").update(await readFile(bundle)).digest("hex"), oracleSha256: oracleHash.digest("hex"), node: process.version, miniflare: version("miniflare"), esbuild: version("esbuild"), workerd: workerdVersion, platform: process.platform, arch: process.arch }
const standardConfiguration = Object.entries(defaults).every(([key, value]) => config[key as keyof typeof defaults] === value)
const createRuntime = (persistence: string) => new Miniflare(convertV4MiniflareOptions({ name: "directory-oracle", inspectorPort: 0, modulesRoot: out, modules: [{ type: "ESModule", path: main }, { type: "ESModule", path: bundle }], compatibilityDate: "2026-08-08", compatibilityFlags: ["nodejs_compat"], durableObjects: { ACTORS: { className: "DirectoryDO", useSQLite: true }, THREADS: { className: "ThreadDO", useSQLite: true } }, resourcePersistencePath: persistence, isolatedResourcePersistencePath: persistence }))

async function scenario(threads: number) {
  const result: Scenario = { threads, phases: [], failures: [] }
  scenarios.push(result)
  const persistence = await mkdtemp(join(tmpdir(), "tardie-directory-oracle-"))
  let runtime = createRuntime(persistence)
  let inspector: Awaited<ReturnType<typeof directoryInspector>> | undefined
  const call = async <Value>(path: string, body?: unknown): Promise<Value> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          const response = await runtime.dispatchFetch(`http://oracle${path}`, { ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), signal: AbortSignal.timeout(config.requestTimeoutMs) })
          const text = await response.text()
          if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${text.slice(0, 2000)}`)
          return JSON.parse(text) as Value
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${path}: deadline exceeded after ${config.requestTimeoutMs}ms`)), config.requestTimeoutMs) }),
      ])
    } finally { clearTimeout(timer) }
  }
  const post = <Value>(path: string, body: unknown) => call<Value>(path, body)
  const lookup = (thread: string) => call<ReturnType<typeof coordinate> | null>(`/oracle/lookup?thread=${encodeURIComponent(thread)}`)
  const calls = (thread: string) => call<number>(`/oracle/calls?thread=${encodeURIComponent(thread)}`)
  const allocate = (name: string, extra: object = {}) => post<ReturnType<typeof coordinate>>("/oracle/allocate", { instance: DIRECTORY_ORACLE_INSTANCE, name, ...extra })
  const prefix = threads * 2 + config.pendingThreads
  let namedChild: ReturnType<typeof coordinate> | undefined
  const stats = () => call<JournalStats>(`/oracle/stats?prefix=${prefix}&pageSize=${config.seedBatchSize}`)
  const restart = async () => {
    inspector?.close()
    inspector = undefined
    await runtime.dispose()
    runtime = createRuntime(persistence)
    await call("/oracle/ready")
    inspector = await directoryInspector(runtime, config.requestTimeoutMs)
  }
  const measure = async (name: string, work: () => Promise<void>) => {
    console.log(JSON.stringify({ threads, phase: name, status: "started" }))
    const active = inspector!
    const before = await active.usage()
    let peakBytes = before.usedSize
    let peakBackingBytes = before.backingStorageSize
    let samples = 1
    let running = true
    let samplingError: unknown
    const sample = async () => {
      const usage = await active.usage()
      peakBytes = Math.max(peakBytes, usage.usedSize)
      peakBackingBytes = Math.max(peakBackingBytes, usage.backingStorageSize)
      samples++
    }
    const sampler = (async () => {
      try { while (running) { await sample(); if (running) await delay(config.sampleIntervalMs) } }
      catch (error) { samplingError = error }
    })()
    const started = performance.now()
    let error: unknown
    try { await work() }
    catch (failure) { error = failure }
    running = false
    await sampler
    const elapsedMs = performance.now() - started
    let after: HeapUsage | undefined
    let instrumentationError: unknown
    try {
      await sample()
      let collecting = true
      await Promise.all([
        active.collect().finally(() => { collecting = false }),
        (async () => { while (collecting) { await call("/oracle/ready"); if (collecting) await delay(config.pollIntervalMs) } })(),
      ])
      after = await active.usage()
    }
    catch (failure) { instrumentationError = failure }
    const errors = [error, samplingError, instrumentationError].filter(error => error !== undefined).map(String)
    if (after) { peakBytes = Math.max(peakBytes, after.usedSize); peakBackingBytes = Math.max(peakBackingBytes, after.backingStorageSize) }
    const phase: Phase = { name, elapsedMs, samples, peakBytes, peakBackingBytes, before, ...(after ? { retainedBytes: after.usedSize, after } : {}), ...(errors.length ? { error: errors.join("; ") } : {}) }
    result.phases.push(phase)
    console.log(JSON.stringify({ threads, ...phase }))
    if (errors.length) throw new Error(errors.join("; "))
  }
  try {
    await call("/oracle/ready")
    for (let start = 0; start < threads; start += config.seedBatchSize) await post("/oracle/seed", { start, count: Math.min(config.seedBatchSize, threads - start), payloadBytes: config.payloadBytes, pending: false })
    for (let start = 0; start < config.pendingThreads; start += config.seedBatchSize) await post("/oracle/seed", { start, count: Math.min(config.seedBatchSize, config.pendingThreads - start), payloadBytes: 0, pending: true })
    await call("/oracle/seeded", {})
    result.seed = await stats()
    assert.equal(result.seed.records, prefix)
    assert.ok(result.seed.bytes >= threads * config.payloadBytes)
    await restart()
    if (config.mode === "control") {
      await measure("full-directory-control", async () => {
        const control = await call<{ allocations: number; retained: boolean }>("/oracle/control")
        assert.equal(control.allocations, threads + config.pendingThreads)
        assert.equal(control.retained, true)
      })
    } else {
      await measure("cold-lookup", async () => { assert.deepEqual(await lookup("historical-0"), coordinate("historical-0")) })
      await measure("historical-lookups", async () => {
        for (let index = 0; index < config.lookupCount; index++) {
          const thread = `historical-${Math.floor(index * (threads - 1) / (config.lookupCount - 1))}`
          assert.deepEqual(await lookup(thread), coordinate(thread))
        }
        assert.equal(await lookup("absent"), null)
        assert.deepEqual(await allocate("historical-0"), coordinate("historical-0"))
        assert.equal(await calls("historical-0"), 0)
      })
      await measure("pending-recovery", async () => {
        for (let index = 0; index < config.pendingThreads; index++) {
          const thread = `pending-${index}`
          const deadline = performance.now() + config.requestTimeoutMs
          while (!(await lookup(thread))) {
            if (performance.now() >= deadline) throw new Error(`Pending provisioning timed out: ${thread}`)
            await delay(config.pollIntervalMs)
          }
          assert.deepEqual(await allocate(thread), coordinate(thread))
          assert.equal(await calls(thread), 1)
          assert.equal(await call<number>(`/oracle/value?thread=${thread}`), 7)
        }
      })
      await measure("allocation-and-retry", async () => {
        for (let index = 0; index < config.freshThreads; index++) {
          const thread = `fresh-${index}`
          const requested = { initialState: { "oracle.value": 7 } }
          const created = await Promise.all([allocate(thread, requested), allocate(thread, requested)])
          for (const result of created) assert.deepEqual(result, coordinate(thread))
          assert.equal(await calls(thread), 1)
          assert.equal(await call<number>(`/oracle/value?thread=${thread}`), 7)
        }
        await call("/oracle/fail?thread=retry")
        assert.deepEqual(await allocate("retry"), coordinate("retry"))
        assert.equal(await calls("retry"), 2)
        const first = await allocate("solver", { parent: coordinate("fresh-0") })
        const second = await allocate("solver", { parent: coordinate("fresh-1") })
        namedChild = second
        assert.notEqual(first.thread, second.thread)
        assert.deepEqual(await allocate("solver", { parent: coordinate("fresh-1") }), second)
      })
      await restart()
      await measure("cold-reopen", async () => {
        for (const thread of ["historical-0", `historical-${threads - 1}`, "pending-0", "fresh-0", "retry"]) assert.deepEqual(await lookup(thread), coordinate(thread))
        assert.equal(await calls("pending-0"), 1)
        assert.equal(await calls("fresh-0"), 1)
        assert.equal(await calls("retry"), 2)
        assert.deepEqual(await allocate("solver", { parent: coordinate("fresh-1") }), namedChild)
        assert.equal(await calls(namedChild!.thread), 1)
      })
    }
    result.prefixAfter = await stats()
    assert.deepEqual(result.prefixAfter, result.seed)
  } catch (error) {
    result.failures.push(String(error))
  } finally {
    inspector?.close()
    await runtime.dispose()
    await rm(persistence, { recursive: true, force: true })
    if (result.phases.length) {
      result.peakBytes = Math.max(...result.phases.map(phase => phase.peakBytes))
      result.peakBackingBytes = Math.max(...result.phases.map(phase => phase.peakBackingBytes))
      const retained = result.phases.flatMap(phase => phase.retainedBytes === undefined ? [] : [phase.retainedBytes])
      if (retained.length) result.retainedBytes = Math.max(...retained)
    }
    await writeFile(join(out, `threads-${threads}.json`), JSON.stringify(result, null, 2))
  }
}

console.log(JSON.stringify({ config, standardConfiguration, out, source }))
let driverError: unknown
try {
  await scenario(config.smallThreads)
  await scenario(config.largeThreads)
} catch (error) { driverError = error }
const failures = scenarios.flatMap(scenario => scenario.failures.map(failure => `${scenario.threads} threads: ${failure}`))
if (driverError !== undefined) failures.push(`Benchmark driver: ${String(driverError)}`)
const [small, large] = scenarios
let retainedGrowthBytes: number | undefined
if (config.mode === "candidate") {
  for (const result of scenarios) {
    if (result.peakBytes === undefined || result.retainedBytes === undefined || result.peakBackingBytes === undefined) failures.push(`${result.threads} threads: missing heap measurements`)
    else {
      if (result.peakBytes > config.maxPeakBytes) failures.push(`${result.threads} threads: peak ${result.peakBytes} > ${config.maxPeakBytes}`)
      if (result.retainedBytes > config.maxRetainedBytes) failures.push(`${result.threads} threads: retained ${result.retainedBytes} > ${config.maxRetainedBytes}`)
      if (result.peakBackingBytes > config.maxBackingBytes) failures.push(`${result.threads} threads: backing storage ${result.peakBackingBytes} > ${config.maxBackingBytes}`)
    }
  }
  if (small?.retainedBytes !== undefined && large?.retainedBytes !== undefined) {
    retainedGrowthBytes = large.retainedBytes - small.retainedBytes
    if (retainedGrowthBytes > config.maxRetainedGrowthBytes) failures.push(`Retained growth ${retainedGrowthBytes} > ${config.maxRetainedGrowthBytes}`)
  }
} else if (large?.peakBytes === undefined || large.retainedBytes === undefined || large.peakBackingBytes === undefined || (large.peakBytes <= config.maxPeakBytes && large.retainedBytes <= config.maxRetainedBytes && large.peakBackingBytes <= config.maxBackingBytes)) failures.push("Full-directory control did not exceed a memory limit")
if (scenarios.length !== 2) failures.push("Both journal sizes must complete")
const report = { passed: failures.length === 0, standardConfiguration, config, source, retainedGrowthBytes, failures, scenarios }
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ passed: report.passed, retainedGrowthBytes, failures, report: join(out, "report.json") }))
process.exitCode = report.passed ? 0 : 1
