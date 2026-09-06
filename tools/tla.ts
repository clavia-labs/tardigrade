import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const DEFAULT_TLC_WORKERS = 1
export const DEFAULT_TLC_TIMEOUT_MILLIS = 120_000

const directories = ["actor", "interaction", "transport", "component", "projection", "log", "runtime", "host", "cloudflare"] as const
type CheckDirectory = typeof directories[number]

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
  pass("host", "Identity", "Identity.cfg"),
  pass("host", "Identity", "IdentityKey.cfg"),
  pass("host", "Identity", "IdentityLive.cfg"),
  counterexample("host", "Identity", "IdentityParent.cfg", "Invariant ThreadSeparation is violated"),
  counterexample("host", "Identity", "IdentityCollision.cfg", "Invariant ThreadSeparation is violated"),
  counterexample("host", "Identity", "IdentityRetry.cfg", "Invariant RetryStable is violated"),
  counterexample("host", "Identity", "IdentityTarget.cfg", "Invariant InvocationSeparation is violated"),
  counterexample("host", "Identity", "IdentityCaller.cfg", "Invariant CallSeparation is violated"),
  pass("interaction", "Delivery", "Delivery.cfg"),
  pass("interaction", "Delivery", "DeliveryLive.cfg"),
  counterexample("interaction", "Delivery", "DeliveryDeadlock.cfg", "AllSettle was violated"),
  pass("transport", "Link", "Link.cfg"),
  pass("transport", "Link", "LinkLive.cfg"),
  counterexample("transport", "Link", "LinkMisroute.cfg", "Invariant NoMisroute is violated"),
  counterexample("transport", "Link", "LinkStale.cfg", "Invariant ResolvedIsFresh is violated"),
  pass("interaction", "Method", "Method.cfg"),
  pass("interaction", "Method", "MethodAlarm.cfg"),
  pass("interaction", "Method", "MethodLive.cfg"),
  counterexample("interaction", "Method", "MethodNoDeadline.cfg", "AllDispatchedCallsTerminate was violated"),
  counterexample("interaction", "Method", "MethodHint.cfg", "Invariant ResponseReversesAcceptedLink is violated"),
  pass("component", "Component", "Component.cfg"),
  counterexample("component", "Component", "ComponentCurrent.cfg", "Invariant CurrentViewRoutable is violated"),
  pass("interaction", "Cancellation", "Cancellation.cfg"),
  counterexample("interaction", "Cancellation", "CancellationIdentity.cfg", "Invariant ExactRequestTarget is violated"),
  counterexample("interaction", "Cancellation", "CancellationEffectLeak.cfg", "Invariant NoNewEffects is violated"),
  counterexample("interaction", "Cancellation", "CancellationNoSignal.cfg", "Invariant OldEffectsSignalled is violated"),
  counterexample("interaction", "Cancellation", "CancellationOpenCall.cfg", "Invariant OpenCallsTerminated is violated"),
  counterexample("interaction", "Cancellation", "CancellationChild.cfg", "Invariant ChildrenCancelled is violated"),
  counterexample("interaction", "Cancellation", "CancellationNoSettle.cfg", "CancellationSettles was violated"),
  counterexample("interaction", "Cancellation", "CancellationUnreachableChild.cfg", "CancellationSettles was violated"),
  pass("interaction", "CancellationDeadline", "CancellationDeadline.cfg"),
  pass("interaction", "CancellationParallel", "CancellationParallel.cfg"),
  counterexample("interaction", "CancellationParallel", "CancellationSerial.cfg", "CancellationSettles was violated"),
  pass("interaction", "InvocationPublication", "InvocationPublication.cfg"),
  counterexample("interaction", "InvocationPublication", "InvocationPublicationEarly.cfg", "Invariant PublishedChildrenOwned is violated"),
  pass("interaction", "InvocationEpoch", "InvocationEpoch.cfg"),
  counterexample("interaction", "InvocationEpoch", "InvocationEpochOverlap.cfg", "Invariant AtMostOneActive is violated"),
  counterexample("interaction", "InvocationEpoch", "InvocationEpochDetached.cfg", "Invariant ResumePreservesContext is violated"),
  pass("interaction", "InvocationDeadline", "InvocationDeadline.cfg"),
  counterexample("interaction", "InvocationDeadline", "InvocationDeadlineLocal.cfg", "Invariant ChildBoundedByParent is violated"),
  pass("projection", "IncrementalProjection", "IncrementalProjection.cfg"),
  counterexample("projection", "IncrementalProjection", "IncrementalProjectionSkip.cfg", "Invariant CacheSound is violated"),
  counterexample("projection", "IncrementalProjection", "IncrementalProjectionStale.cfg", "Invariant NoStaleCommit is violated"),
  counterexample("projection", "IncrementalProjection", "IncrementalProjectionSnapshot.cfg", "Invariant SnapshotSound is violated"),
  pass("runtime", "Coherence", "Coherence.cfg"),
  counterexample("runtime", "Coherence", "CoherenceBatch.cfg", "Invariant NoSuppressedCommit is violated"),
  counterexample("runtime", "Coherence", "CoherenceRevalidate.cfg", "Invariant NoSuppressedCommit is violated"),
  pass("host", "CommitTail", "CommitTail.cfg"),
  counterexample("host", "CommitTail", "CommitTailDrop.cfg", "CommittedEventuallyRead was violated"),
  pass("interaction", "Child", "Child.cfg"),
  pass("interaction", "Child", "ChildLive.cfg"),
  counterexample("interaction", "Child", "ChildEarly.cfg", "Invariant DeliveryFollowsParent is violated"),
  counterexample("interaction", "Child", "ChildRecompute.cfg", "Invariant DeliveryFollowsParent is violated"),
  pass("actor", "ActorInstance", "ActorInstance.cfg"),
  pass("actor", "ActorInstance", "ActorInstanceLive.cfg"),
  counterexample("actor", "ActorInstance", "ActorInstanceAuthority.cfg", "Invariant AcceptedAuthorized is violated"),
  counterexample("actor", "ActorInstance", "ActorInstanceChildEscape.cfg", "Invariant ChildInheritsInstance is violated"),
  counterexample("actor", "ActorInstance", "ActorInstanceObjectAlias.cfg", "Invariant RoutedObjectIsolation is violated"),
  counterexample("actor", "ActorInstance", "ActorInstanceGlobalList.cfg", "Invariant ListingIsolation is violated"),
  counterexample("actor", "ActorInstance", "ActorInstanceSharedKey.cfg", "Invariant LiveKeysRemain is violated"),
  pass("host", "ConcurrentDriver", "ConcurrentDriver.cfg"),
  pass("host", "ConcurrentDriver", "ConcurrentDriverLive.cfg"),
  counterexample("host", "ConcurrentDriver", "ConcurrentDriverUnbounded.cfg", "Invariant ConcurrencyBound is violated"),
  counterexample("host", "ConcurrentDriver", "ConcurrentDriverParkLeak.cfg", "Invariant ParkReleasesFiber is violated"),
  pass("host", "Driver", "Driver.cfg"),
  pass("host", "Driver", "DriverLive.cfg"),
  pass("host", "Driver", "DriverIsolate.cfg"),
  pass("host", "Driver", "DriverPoisoned.cfg"),
  counterexample("host", "Driver", "DriverAlarmRace.cfg", "Invariant Accounting is violated"),
  counterexample("host", "Driver", "DriverDrop.cfg", "Invariant Accounting is violated"),
  pass("runtime", "Execution", "Execution.cfg"),
  counterexample("runtime", "Execution", "ExecutionReadyLeak.cfg", "Invariant ParkedAttemptReleases is violated"),
  pass("runtime", "Guard", "Guard.cfg"),
  counterexample("runtime", "Guard", "GuardRace.cfg", "Invariant NoDoubleOutcome is violated"),
  pass("component", "ModelPolicy", "ModelPolicy.cfg"),
  counterexample("component", "ModelPolicy", "ModelPolicyWiden.cfg", "Invariant ChildCannotWiden is violated"),
  pass("projection", "Projection", "Projection.cfg"),
  counterexample("projection", "Projection", "ProjectionView.cfg", "Invariant ViewFaithful is violated"),
  pass("projection", "ProjectionAlgebra", "ProjectionAlgebra.cfg"),
  counterexample("projection", "ProjectionAlgebra", "ProjectionAlgebraCurrent.cfg", "Invariant CurrentOutputSufficient is violated"),
  counterexample("projection", "ProjectionAlgebra", "ProjectionAlgebraBalance.cfg", "Invariant BalanceOnlySufficient is violated"),
  pass("projection", "ProjectionVersion", "ProjectionVersion.cfg"),
  counterexample("projection", "ProjectionVersion", "ProjectionVersionGuess.cfg", "Invariant GuessMigrationSound is violated"),
  counterexample("projection", "ProjectionVersion", "ProjectionVersionRefine.cfg", "Invariant CoarseSufficientForNew is violated"),
  pass("runtime", "Reconcile", "Reconcile.cfg"),
  pass("runtime", "Replay", "Replay.cfg"),
  counterexample("runtime", "Replay", "ReplayTrust.cfg", "Invariant RightAnswer is violated"),
  pass("host", "Thread", "Thread.cfg"),
  pass("host", "Thread", "ThreadLive.cfg"),
  counterexample("host", "Thread", "ThreadSplit.cfg", "Invariant CreationAtomic is violated"),
  counterexample("host", "Thread", "ThreadDepth.cfg", "Invariant LineageValid is violated"),
  counterexample("host", "Thread", "ThreadConflict.cfg", "Invariant CreationOnce is violated"),
  pass("runtime", "Totality", "Totality.cfg"),
  counterexample("runtime", "Totality", "TotalityVoid.cfg", "Invariant NoVoidCur is violated"),
  pass("cloudflare", "DurableExecution", "DurableExecution.cfg"),
  pass("cloudflare", "ActiveDrive", "ActiveDrive.cfg"),
  pass("cloudflare", "ActiveDrive", "ActiveDriveOldSafety.cfg"),
  counterexample("cloudflare", "ActiveDrive", "ActiveDriveUnretained.cfg", "Invariant AdmissionRetained is violated"),
  counterexample("cloudflare", "ActiveDrive", "ActiveDriveRetired.cfg", "Invariant JoinedWorkDrained is violated"),
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
  : directory === "host"
    ? join(root, "packages", "host", "tla")
    : join(root, "packages", "core", "tla", directory)
const declaredConfigs = checks.map((check) => `${check.directory}/${check.config}`)
const declarations = new Set(declaredConfigs)
if (declarations.size !== declaredConfigs.length) throw new Error("the TLA manifest contains a duplicate configuration")
const presentConfigs = (
  await Promise.all(
    directories.map(async (directory) =>
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
        `-DTLA-Library=${join(root, "packages", "core", "tla", "log")}`,
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
