// workLifecycle composes execution and cancellation through obligation's shared attempt transitions (invariant).
// The finite instance has one stable reference, two serialized inputs, two runtime images, and a two-attempt budget per obligation.
// Attempts precharge a durable budget; typed cleanup failures retry, defects block, and timeouts retain producer uncertainty.
// Explicit resume permits retry within the remaining budget; budget exhaustion preserves the cleanup obligation and input.
// Cancellation atomically creates cleanup before discharging execution; cleanup starts only after producer quiescence.
// Crash loses volatile attempt results; timeout records a durable outcome for abandoned attempts.
// Quiescence requires an external acknowledgement and has no unconditional liveness guarantee.
// Clock ticks abstract reaching a configured deadline; actual durations, handles, forwarding, journal/checkpoint ordering, and TypeScript refinement are outside this model.
// cancellation.qnt checks owned forwarding and current-runtime liveness counterexamples; effectRecovery.qnt checks checkpoint and caller delivery.
// quint verify /absolute/path/to/workLifecycle.qnt --backend tlc --invariant invariant
module workLifecycle {
  import obligation as work from "./obligation"

  type Identity = { ref: int, input: int }
  type Dispatch = { identity: Identity, kind: str, attempt: int, image: int }
  pure val kinds = Set("execution", "cleanup")
  pure val attemptLimit = 2
  var accepted: Set[Identity]
  var payload: Set[Identity]
  var obligations: str -> work::Work
  var cancelled: bool
  var online: bool
  var image: int
  var dispatched: Set[Dispatch]
  var producers: Set[str]

  action init = all {
    accepted' = Set(), payload' = Set(), obligations' = kinds.mapBy(_ => work::initial),
    cancelled' = false, online' = true, image' = 0, dispatched' = Set(), producers' = Set(),
  }
  action hold = all {
    accepted' = accepted, payload' = payload, obligations' = obligations, cancelled' = cancelled,
    online' = online, image' = image, dispatched' = dispatched, producers' = producers,
  }
  action updateWork(kind: str, after: work::Work, nextProducers: Set[str]): bool = all {
    obligations' = obligations.set(kind, after),
    accepted' = accepted, payload' = payload, cancelled' = cancelled, online' = online, image' = image, dispatched' = dispatched, producers' = nextProducers,
  }
  action accept = {
    nondet input = Set(0, 1).oneOf()
    val identity = { ref: 0, input: input }
    all {
      online, accepted == Set(),
      accepted' = Set(identity), payload' = Set(identity),
      obligations' = obligations.set("execution", work::accept(obligations.get("execution"))),
      cancelled' = cancelled, online' = online, image' = image, dispatched' = dispatched, producers' = producers,
    }
  }
  def needsInput(kind: str): bool = work::needsInput(obligations.get(kind))
  val cleanupAllowed = not(needsInput("execution"))
  action begin(kind: str): bool = all {
    online, payload == accepted, accepted != Set(), work::mayBegin(obligations.get(kind), attemptLimit),
    kind == "execution" or cleanupAllowed,
    obligations' = obligations.set(kind, work::begin(obligations.get(kind))),
    dispatched' = dispatched.union(accepted.map(identity => { identity: identity, kind: kind, attempt: obligations.get(kind).attempts + 1, image: image })),
    accepted' = accepted, payload' = payload, cancelled' = cancelled, online' = online, image' = image, producers' = producers.union(Set(kind)),
  }
  action complete(kind: str, outcome: str): bool = all {
    online, work::mayReturn(obligations.get(kind)), outcome.in(Set("success", "failure", "died")),
    updateWork(kind, work::complete(obligations.get(kind), outcome), producers.exclude(Set(kind))),
  }
  // deliver ignores results from completed or superseded attempts under the same obligation identity.
  action deliver(kind: str, attempt: int, outcome: str): bool =
    if (attempt == obligations.get(kind).attempts and work::mayReturn(obligations.get(kind))) complete(kind, outcome) else hold
  action record(kind: str): bool = all {
    online, obligations.get(kind).phase == "ready",
    updateWork(kind, work::record(obligations.get(kind), kind, attemptLimit), producers),
  }
  action hang(kind: str): bool = all {
    online, work::mayReturn(obligations.get(kind)), updateWork(kind, obligations.get(kind).with("phase", "hung"), producers),
  }
  // timeout is enabled for a pending attempt even when its producer no longer responds.
  action timeout(kind: str): bool = all {
    online, obligations.get(kind).pending, obligations.get(kind).phase != "ready",
    updateWork(kind, work::timeout(obligations.get(kind), kind), producers),
  }
  action acknowledgeStop(kind: str): bool = all {
    online, not(obligations.get(kind).quiescent), obligations.get(kind).phase != "ready",
    updateWork(kind, work::acknowledgeStop(obligations.get(kind)), producers.exclude(Set(kind))),
  }
  action resume(kind: str): bool = all {
    online, obligations.get(kind).owed, not(obligations.get(kind).pending), obligations.get(kind).quiescent,
    obligations.get(kind).blocked != "",
    updateWork(kind, work::resume(obligations.get(kind), attemptLimit), producers),
  }
  action cancel = all {
    online, accepted != Set(), obligations.get("execution").owed, not(cancelled),
    obligations' = obligations.set("execution", obligations.get("execution").with("owed", false))
      .set("cleanup", work::accept(obligations.get("cleanup"))),
    cancelled' = true, accepted' = accepted, payload' = payload, online' = online, image' = image, dispatched' = dispatched, producers' = producers,
  }
  action release = all {
    accepted != Set(), kinds.forall(kind => not(needsInput(kind))),
    payload' = Set(), accepted' = accepted, obligations' = obligations, cancelled' = cancelled,
    online' = online, image' = image, dispatched' = dispatched, producers' = producers,
  }
  action crash = all {
    online, online' = false, obligations' = kinds.mapBy(kind => work::crash(obligations.get(kind))),
    accepted' = accepted, payload' = payload, cancelled' = cancelled, image' = image, dispatched' = dispatched, producers' = producers,
  }
  action reopen = all {
    not(online), online' = true, image' = 1 - image,
    accepted' = accepted, payload' = payload, obligations' = obligations, cancelled' = cancelled, dispatched' = dispatched, producers' = producers,
  }
  action step = {
    nondet kind = kinds.oneOf()
    nondet outcome = Set("success", "failure", "died").oneOf()
    nondet attempt = 1.to(attemptLimit).oneOf()
    any { accept, begin(kind), complete(kind, outcome), deliver(kind, attempt, outcome), record(kind), hang(kind), timeout(kind), acknowledgeStop(kind), resume(kind), cancel, release, crash, reopen, hold }
  }

  // stepEarlyRelease drops input while an obligation or producer still needs it.
  action stepEarlyRelease = any { step, all {
    kinds.exists(kind => needsInput(kind)), payload' = Set(), accepted' = accepted, obligations' = obligations,
    cancelled' = cancelled, online' = online, image' = image, dispatched' = dispatched, producers' = producers,
  } }
  // stepTimeoutAcknowledgesStop treats elapsed time as evidence that the producer stopped.
  action stepTimeoutAcknowledgesStop = {
    nondet kind = kinds.oneOf()
    any { step, all {
      online, obligations.get(kind).pending, obligations.get(kind).phase != "ready",
      updateWork(kind, work::timeout(obligations.get(kind), kind).with("quiescent", true), producers),
    } }
  }
  // stepFailedCleanupDischarges treats a typed cleanup failure as successful discharge.
  action stepFailedCleanupDischarges = any { step, all {
    online, obligations.get("cleanup").phase == "ready", obligations.get("cleanup").result == "failure",
    updateWork("cleanup", work::record(obligations.get("cleanup"), "execution", attemptLimit), producers),
  } }

  type DurableWork = { owed: bool, attempts: int, pending: bool, quiescent: bool, outcomes: int -> str, blocked: str }
  type Operation = { identity: Identity, execution: DurableWork, cleanup: Set[DurableWork] }
  pure def durable(value: work::Work): DurableWork = {
    owed: value.owed, attempts: value.attempts, pending: value.pending,
    quiescent: value.quiescent, outcomes: value.outcomes, blocked: value.blocked,
  }
  pure def encodeOperation(identity: Identity, execution: work::Work, cleanup: work::Work, cancelling: bool): Operation = {
    identity: identity, execution: durable(execution), cleanup: if (cancelling) Set(durable(cleanup)) else Set(),
  }
  pure def decodeOperation(value: Operation): str -> DurableWork = Map(
    "execution" -> value.execution,
    "cleanup" -> value.cleanup.fold(durable(work::initial), (_, cleanup) => cleanup),
  )
  // checkpointProjection preserves durable attempt state while excluding volatile results and running phases.
  val checkpointProjection = accepted.map(identity => encodeOperation(identity, obligations.get("execution"), obligations.get("cleanup"), cancelled))
  val checkpointRoundTrip = checkpointProjection.forall(operation =>
    decodeOperation(operation) == kinds.mapBy(kind => durable(obligations.get(kind))))
  val checkpointCrashStable = kinds.forall(kind => durable(work::crash(obligations.get(kind))) == durable(obligations.get(kind)))
  val checkpointCleanupPreserved = cancelled implies checkpointProjection.forall(operation => operation.cleanup == Set(durable(obligations.get("cleanup"))))

  val inputRetained = kinds.exists(kind => needsInput(kind)) implies payload == accepted and accepted != Set()
  val inputStable = payload.subseteq(accepted) and accepted.size() <= 1
    and dispatched.forall(attempt => accepted.contains(attempt.identity) and attempt.image.in(Set(0, 1)))
  val cleanupQuiescent = obligations.get("cleanup").pending implies cleanupAllowed
  val cleanupDischargeSound = cancelled and not(obligations.get("cleanup").owed) implies
    obligations.get("cleanup").outcomes.keys().exists(attempt => obligations.get("cleanup").outcomes.get(attempt) == "success")
  val quiescenceSound = kinds.forall(kind => obligations.get(kind).quiescent implies not(producers.contains(kind)))
  val budgetDurable = kinds.forall(kind => obligations.get(kind).attempts <= attemptLimit)
  val identityStable = dispatched.forall(attempt => attempt.kind.in(kinds) and attempt.attempt.in(1.to(attemptLimit)))
  val invariant = all {
    producers.subseteq(kinds), obligations.keys() == kinds, kinds.forall(kind => work::wellFormed(obligations.get(kind), attemptLimit)),
    checkpointRoundTrip, checkpointCrashStable, checkpointCleanupPreserved, inputRetained, inputStable, quiescenceSound, cleanupQuiescent, cleanupDischargeSound, budgetDurable, identityStable,
    accepted.forall(identity => identity.ref == 0 and identity.input.in(Set(0, 1))), image.in(Set(0, 1)),
    obligations.get("cleanup").owed implies cancelled,
  }

  // attemptRecorded observes durable outcome recording without claiming successful cleanup or producer quiescence.
  def attemptRecorded(kind: str): bool = not(obligations.get(kind).pending)
  temporal fairOutcomes = eventually(always(online)) and kinds.forall(kind =>
    record(kind).weakFair((accepted, payload, obligations, cancelled, online, image, dispatched, producers))
      and timeout(kind).weakFair((accepted, payload, obligations, cancelled, online, image, dispatched, producers)))
  temporal attemptsEnd = fairOutcomes implies kinds.forall(kind =>
    obligations.get(kind).pending.leadsTo(attemptRecorded(kind)))

  run cancellationHandoffTest = init.then(accept).then(begin("execution")).then(cancel)
    .expect(invariant and not(cleanupAllowed))
    .then(complete("execution", "success")).then(record("execution")).then(begin("cleanup"))
    .then(complete("cleanup", "success")).then(record("cleanup")).then(release)
    .expect(invariant and payload == Set())
  run cleanupFailureBudgetTest = init.then(accept).then(cancel).then(begin("cleanup"))
    .then(complete("cleanup", "failure")).then(record("cleanup")).then(begin("cleanup"))
    .then(complete("cleanup", "failure")).then(record("cleanup"))
    .expect(invariant and obligations.get("cleanup").blocked == "budget" and needsInput("cleanup"))
    .then(crash).then(reopen).expect(invariant and obligations.get("cleanup").attempts == attemptLimit)
  run cleanupDeathTest = init.then(accept).then(cancel).then(begin("cleanup"))
    .then(complete("cleanup", "died")).then(record("cleanup")).then(crash).then(reopen)
    .expect(invariant and obligations.get("cleanup").blocked == "died" and needsInput("cleanup"))
    .then(resume("cleanup")).then(begin("cleanup")).then(complete("cleanup", "success")).then(record("cleanup"))
    .then(release).expect(invariant and payload == Set())
  run hungSubmissionTest = init.then(accept).then(begin("execution")).then(hang("execution")).then(cancel)
    .then(timeout("execution")).expect(invariant and not(cleanupAllowed) and payload == accepted)
    .then(acknowledgeStop("execution")).then(begin("cleanup")).expect(invariant)
  run hungCleanupTest = init.then(accept).then(cancel).then(begin("cleanup")).then(hang("cleanup"))
    .then(timeout("cleanup")).expect(invariant and needsInput("cleanup") and not(obligations.get("cleanup").quiescent))
    .then(acknowledgeStop("cleanup")).then(resume("cleanup")).then(begin("cleanup"))
    .then(complete("cleanup", "success")).then(record("cleanup")).then(release).expect(invariant)
  run crashBeforeOutcomeTest = init.then(accept).then(begin("execution")).then(complete("execution", "success"))
    .then(crash).then(reopen).expect(invariant and obligations.get("execution").pending)
    .then(timeout("execution")).expect(invariant and payload == accepted)
    .then(acknowledgeStop("execution")).then(release).expect(invariant)
  run deploymentTest = init.then(accept).then(begin("execution")).then(cancel)
    .then(complete("execution", "success")).then(record("execution")).then(crash).then(reopen)
    .then(begin("cleanup")).expect(invariant and dispatched.exists(attempt => attempt.image == 1))
  run checkpointCleanupTest = init.then(accept).then(cancel).then(begin("cleanup"))
    .then(complete("cleanup", "failure")).then(record("cleanup")).then(crash).then(reopen)
    .expect(invariant and checkpointRoundTrip and checkpointCleanupPreserved and needsInput("cleanup"))
  run staleOutcomeTest = init.then(accept).then(cancel).then(begin("cleanup"))
    .then(complete("cleanup", "failure")).then(record("cleanup")).then(begin("cleanup"))
    .then(deliver("cleanup", 1, "success"))
    .expect(invariant and obligations.get("cleanup").pending and obligations.get("cleanup").outcomes.get(1) == "failure")
    .then(complete("cleanup", "success")).then(record("cleanup")).then(deliver("cleanup", 1, "died"))
    .expect(invariant and not(obligations.get("cleanup").owed))
  run earlyReleaseTest = init.then(accept).then(all {
    payload' = Set(), accepted' = accepted, obligations' = obligations, cancelled' = cancelled,
    online' = online, image' = image, dispatched' = dispatched, producers' = producers,
  }).expect(not(inputRetained))
  run timeoutAcknowledgesStopTest = init.then(accept).then(begin("execution")).then(hang("execution"))
    .then(updateWork("execution", work::timeout(obligations.get("execution"), "execution").with("quiescent", true), producers))
    .expect(not(quiescenceSound))
  run failedCleanupDischargesTest = init.then(accept).then(cancel).then(begin("cleanup"))
    .then(complete("cleanup", "failure")).then(updateWork("cleanup", work::record(obligations.get("cleanup"), "execution", attemptLimit), producers))
    .expect(not(cleanupDischargeSound))

}
