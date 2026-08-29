import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const DEFAULT_TLC_WORKERS = 1
export const DEFAULT_TLC_TIMEOUT_MILLIS = 120_000

type CheckDirectory = "communication" | "runtime" | "cloudflare"

interface PassingCheck {
  readonly directory: CheckDirectory
  readonly module: string
  readonly config: string
  readonly outcome: "pass"
}

interface CounterexampleCheck {
  readonly directory: CheckDirectory
  readonly module: string
  readonly config: string
  readonly outcome: "counterexample"
  readonly evidence: string
}

type Check = PassingCheck | CounterexampleCheck

const pass = (directory: Check["directory"], module: string, config: string): PassingCheck => ({
  directory,
  module,
  config,
  outcome: "pass"
})

const counterexample = (
  directory: Check["directory"],
  module: string,
  config: string,
  evidence: string
): CounterexampleCheck => ({ directory, module, config, outcome: "counterexample", evidence })

export const checks: ReadonlyArray<Check> = [
  pass("communication", "Delivery", "Delivery.cfg"),
  pass("communication", "Delivery", "DeliveryLive.cfg"),
  counterexample("communication", "Delivery", "DeliveryDeadlock.cfg", "AllSettle was violated"),
  pass("communication", "Link", "Link.cfg"),
  pass("communication", "Link", "LinkLive.cfg"),
  counterexample("communication", "Link", "LinkMisroute.cfg", "Invariant NoMisroute is violated"),
  counterexample("communication", "Link", "LinkStale.cfg", "Invariant ResolvedIsFresh is violated"),
  pass("communication", "Method", "Method.cfg"),
  pass("communication", "Method", "MethodAlarm.cfg"),
  pass("communication", "Method", "MethodLive.cfg"),
  counterexample("communication", "Method", "MethodNoDeadline.cfg", "AllDispatchedCallsTerminate was violated"),
  counterexample("communication", "Method", "MethodHint.cfg", "Invariant ResponseReversesAcceptedLink is violated"),
  pass("runtime", "Component", "Component.cfg"),
  counterexample("runtime", "Component", "ComponentCurrent.cfg", "Invariant CurrentViewRoutable is violated"),
  pass("runtime", "Coherence", "Coherence.cfg"),
  counterexample("runtime", "Coherence", "CoherenceBatch.cfg", "Invariant NoSuppressedCommit is violated"),
  counterexample("runtime", "Coherence", "CoherenceRevalidate.cfg", "Invariant NoSuppressedCommit is violated"),
  pass("runtime", "Child", "Child.cfg"),
  pass("runtime", "Child", "ChildLive.cfg"),
  counterexample("runtime", "Child", "ChildEarly.cfg", "Invariant DeliveryFollowsParent is violated"),
  counterexample("runtime", "Child", "ChildRecompute.cfg", "Invariant DeliveryFollowsParent is violated"),
  pass("runtime", "ActorInstance", "ActorInstance.cfg"),
  pass("runtime", "ActorInstance", "ActorInstanceLive.cfg"),
  counterexample("runtime", "ActorInstance", "ActorInstanceAuthority.cfg", "Invariant AcceptedAuthorized is violated"),
  counterexample("runtime", "ActorInstance", "ActorInstanceChildEscape.cfg", "Invariant ChildInheritsInstance is violated"),
  counterexample("runtime", "ActorInstance", "ActorInstanceObjectAlias.cfg", "Invariant RoutedObjectIsolation is violated"),
  counterexample("runtime", "ActorInstance", "ActorInstanceGlobalList.cfg", "Invariant ListingIsolation is violated"),
  counterexample("runtime", "ActorInstance", "ActorInstanceSharedKey.cfg", "Invariant LiveKeysRemain is violated"),
  pass("runtime", "ConcurrentDriver", "ConcurrentDriver.cfg"),
  pass("runtime", "ConcurrentDriver", "ConcurrentDriverLive.cfg"),
  counterexample("runtime", "ConcurrentDriver", "ConcurrentDriverUnbounded.cfg", "Invariant ConcurrencyBound is violated"),
  counterexample("runtime", "ConcurrentDriver", "ConcurrentDriverParkLeak.cfg", "Invariant ParkReleasesFiber is violated"),
  pass("runtime", "Driver", "Driver.cfg"),
  pass("runtime", "Driver", "DriverLive.cfg"),
  pass("runtime", "Driver", "DriverIsolate.cfg"),
  pass("runtime", "Driver", "DriverPoisoned.cfg"),
  counterexample("runtime", "Driver", "DriverAlarmRace.cfg", "Invariant Accounting is violated"),
  counterexample("runtime", "Driver", "DriverDrop.cfg", "Invariant Accounting is violated"),
  pass("runtime", "Execution", "Execution.cfg"),
  counterexample("runtime", "Execution", "ExecutionReadyLeak.cfg", "Invariant ParkedAttemptReleases is violated"),
  pass("runtime", "Guard", "Guard.cfg"),
  counterexample("runtime", "Guard", "GuardRace.cfg", "Invariant NoDoubleOutcome is violated"),
  pass("runtime", "ModelPolicy", "ModelPolicy.cfg"),
  counterexample("runtime", "ModelPolicy", "ModelPolicyWiden.cfg", "Invariant ChildCannotWiden is violated"),
  pass("runtime", "Projection", "Projection.cfg"),
  counterexample("runtime", "Projection", "ProjectionView.cfg", "Invariant ViewFaithful is violated"),
  pass("runtime", "Reconcile", "Reconcile.cfg"),
  pass("runtime", "Replay", "Replay.cfg"),
  counterexample("runtime", "Replay", "ReplayTrust.cfg", "Invariant RightAnswer is violated"),
  pass("runtime", "Thread", "Thread.cfg"),
  pass("runtime", "Thread", "ThreadLive.cfg"),
  counterexample("runtime", "Thread", "ThreadSplit.cfg", "Invariant CreationAtomic is violated"),
  counterexample("runtime", "Thread", "ThreadDepth.cfg", "Invariant LineageValid is violated"),
  counterexample("runtime", "Thread", "ThreadConflict.cfg", "Invariant CreationOnce is violated"),
  pass("runtime", "Totality", "Totality.cfg"),
  counterexample("runtime", "Totality", "TotalityVoid.cfg", "Invariant NoVoidCur is violated"),
  pass("cloudflare", "DurableExecution", "DurableExecution.cfg"),
  counterexample("cloudflare", "DurableExecution", "DurableExecutionNoTurn.cfg", "Invariant CoveredBeforeDrive is violated"),
  counterexample("cloudflare", "DurableExecution", "DurableExecutionNoWatchdog.cfg", "Invariant OwedHasWake is violated"),
  pass("cloudflare", "ThreadCreation", "ThreadCreation.cfg"),
  pass("cloudflare", "ThreadCreation", "ThreadCreationLive.cfg"),
  counterexample("cloudflare", "ThreadCreation", "ThreadCreationCurrent.cfg", "Invariant CreatedHasAccepted is violated")
]

const jar = process.env["TLA2TOOLS_JAR"]
if (jar === undefined || jar === "") throw new Error("TLA2TOOLS_JAR must name an absolute tla2tools.jar path")

const java = process.env["TLA_JAVA"] ?? "java"
const workersText = process.env["TLA_WORKERS"] ?? String(DEFAULT_TLC_WORKERS)
const workers = Number(workersText)
if (!Number.isSafeInteger(workers) || workers <= 0) throw new Error("TLA_WORKERS must be a positive integer")

const timeoutText = process.env["TLA_TIMEOUT_MILLIS"] ?? String(DEFAULT_TLC_TIMEOUT_MILLIS)
const timeoutMillis = Number(timeoutText)
if (!Number.isSafeInteger(timeoutMillis) || timeoutMillis <= 0) {
  throw new Error("TLA_TIMEOUT_MILLIS must be a positive integer")
}

const selected = new Set(process.argv.slice(2))
const suite = selected.size === 0 ? checks : checks.filter((check) => selected.has(check.module))
const known = new Set(checks.map((check) => check.module))
const unknown = [...selected].filter((module) => !known.has(module))
if (unknown.length > 0) throw new Error(`unknown TLA module: ${unknown.join(", ")}`)

const root = join(import.meta.dir, "..")
const directoryOf = (directory: Check["directory"]): string => directory === "cloudflare"
  ? join(root, "platform", "cloudflare", "tla")
  : join(root, "packages", "core", "tla", directory)
const declaredConfigs = checks.map((check) => `${check.directory}/${check.config}`)
const declarations = new Set(declaredConfigs)
if (declarations.size !== declaredConfigs.length) throw new Error("the TLA manifest contains a duplicate configuration")
const presentConfigs = (
  await Promise.all(
    (["communication", "runtime", "cloudflare"] as const).map(async (directory) =>
      (await readdir(directoryOf(directory)))
        .filter((file) => file.endsWith(".cfg"))
        .map((file) => `${directory}/${file}`)
    )
  )
).flat()
const undeclared = presentConfigs.filter((config) => !declarations.has(config))
const missing = declaredConfigs.filter((config) => !presentConfigs.includes(config))
if (undeclared.length > 0 || missing.length > 0) {
  throw new Error(`TLA manifest mismatch; undeclared: ${undeclared.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`)
}
const stateRoot = await mkdtemp(join(tmpdir(), "tardigrade-tlc-"))
let failures = 0

try {
  for (const check of suite) {
    const directory = directoryOf(check.directory)
    const state = join(stateRoot, `${check.module}-${check.config}`)
    const child = Bun.spawn(
      [
        java,
        "-XX:+UseParallelGC",
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        String(workers),
        "-noGenerateSpecTE",
        "-metadir",
        state,
        "-config",
        check.config,
        `${check.module}.tla`
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe" }
    )
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMillis)
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    clearTimeout(timeout)
    const output = `${stdout}\n${stderr}`
    const correct = !timedOut && (check.outcome === "pass" ? code === 0 : code !== 0 && output.includes(check.evidence))
    if (correct) {
      console.log(`ok ${check.directory}/${check.config}`)
      continue
    }
    failures += 1
    console.error(`failed ${check.directory}/${check.config}`)
    if (timedOut) console.error(`TLC exceeded TLA_TIMEOUT_MILLIS=${timeoutMillis}`)
    console.error(output.trim())
  }
} finally {
  await rm(stateRoot, { recursive: true, force: true })
}

if (failures > 0) throw new Error(`${failures} TLA check${failures === 1 ? "" : "s"} failed`)
