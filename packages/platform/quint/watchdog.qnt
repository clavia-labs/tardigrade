// watchdog models journal-derived actor work, atomic message admission, and durable recovery wakes (wakeCoverage, eventualSettlement).
// The finite instance has two actors, one message per actor, and two durable effect settlements per message.
// Crash removes staged input and volatile execution; committed messages, settlements, and alarms survive.
// An interrupted alarm delivery remains retryable until acknowledged; initFiniteRetry exposes exhaustion of a finite budget.
// Eventual settlement assumes weakly fair delivery and execution and an eventual crash-free suffix.
// External effect idempotency, wall-clock deadlines, and TypeScript refinement are outside this model.
module watchdog {
  type State = {
    requested: Set[int], remaining: (int, int), staged: int,
    wake: bool, retrying: bool, phase: str, snapshot: Set[int], crashed: bool,
    atomicAdmission: bool, renewWatchdog: bool, preserveLaterWake: bool, platformRetries: bool,
    retryLimit: int, retriesLeft: int,
  }
  pure val actors = Set(0, 1)
  pure def count(s: State, actor: int): int = if (actor == 0) s.remaining._1 else s.remaining._2
  pure def replace(s: State, actor: int, value: int): (int, int) =
    if (actor == 0) (value, s.remaining._2) else (s.remaining._1, value)
  pure def pending(s: State): Set[int] = s.requested.filter(actor => count(s, actor) > 0)
  pure def initial(atomic: bool, renew: bool, preserve: bool, retries: bool): State = {
    requested: Set(), remaining: (0, 0), staged: -1,
    wake: false, retrying: false, phase: "idle", snapshot: Set(), crashed: false,
    atomicAdmission: atomic, renewWatchdog: renew, preserveLaterWake: preserve, platformRetries: retries,
    retryLimit: -1, retriesLeft: -1,
  }

  var state: State
  action init = state' = initial(true, true, true, true)
  action initWithoutAdmissionWake = state' = initial(false, true, true, true)
  action initWithoutRenewal = state' = initial(true, false, true, true)
  action initWithoutRetry = state' = initial(true, true, true, false)
  action initStaleClear = state' = initial(true, true, false, true)
  action initFiniteRetry = state' = initial(true, true, true, true).with("retryLimit", 2).with("retriesLeft", 2)

  action stage(actor: int): bool = all {
    actor.in(actors), not(state.requested.contains(actor)), state.staged == -1,
    state' = state.with("staged", actor).with("crashed", false),
  }

  // receive commits the message and its immediate wake before acknowledgement or actor execution.
  action receive = {
    val requested = state.requested.union(Set(state.staged))
    val immediate = not(state.atomicAdmission) and state.phase == "idle"
    all {
      state.staged.in(actors),
      state' = state.with("requested", requested).with("remaining", replace(state, state.staged, 2))
        .with("staged", -1).with("wake", state.wake or state.atomicAdmission)
        .with("phase", if (immediate) "driving" else state.phase)
        .with("snapshot", if (immediate) requested else state.snapshot).with("crashed", false),
    }
  }

  // fire consumes an alarm and establishes an unacknowledged platform delivery before rearming.
  action fire = all {
    state.phase == "idle", state.wake,
    state' = state.with("wake", false).with("retrying", true).with("phase", "arming")
      .with("snapshot", state.requested).with("retriesLeft", state.retryLimit).with("crashed", false),
  }
  action redeliver = all {
    state.phase == "idle", state.retrying,
    state' = state.with("phase", "arming").with("snapshot", state.requested).with("crashed", false),
  }
  action armRecovery = all {
    state.phase == "arming",
    state' = state.with("wake", state.wake or state.renewWatchdog).with("phase", "driving").with("crashed", false),
  }

  action completeEffect(actor: int): bool = all {
    state.phase == "driving", state.snapshot.contains(actor), count(state, actor) > 0,
    state' = state.with("remaining", replace(state, actor, count(state, actor) - 1)).with("crashed", false),
  }
  // returnDelivery permits background actor work to outlive its successfully acknowledged alarm invocation.
  action returnDelivery = all {
    state.phase == "driving", state.retrying,
    state' = state.with("retrying", false).with("crashed", false),
  }
  action finishPass = all {
    state.phase == "driving", state.snapshot.forall(actor => count(state, actor) == 0),
    state' = state.with("phase", "finishing").with("crashed", false),
  }
  // synchronize clears covered work while preserving admissions made after the pass snapshot.
  action synchronize = all {
    state.phase == "finishing",
    state' = state.with("wake", state.wake and state.preserveLaterWake and state.requested != state.snapshot)
      .with("retrying", false).with("phase", "idle").with("snapshot", Set()).with("crashed", false),
  }

  action crash = {
    val interrupted = state.retrying and state.phase != "idle"
    state' = state.with("staged", -1).with("phase", "idle").with("snapshot", Set())
      .with("retrying", state.retrying and state.platformRetries and (not(interrupted) or state.retriesLeft != 0))
      .with("retriesLeft", if (interrupted and state.retriesLeft > 0) state.retriesLeft - 1 else state.retriesLeft)
      .with("crashed", true)
  }
  action idle = state' = state.with("crashed", false)
  action stageAny = { nondet actor = actors.oneOf(); stage(actor) }
  action completeAny = { nondet actor = actors.oneOf(); completeEffect(actor) }
  action step = any { stageAny, receive, fire, redeliver, armRecovery, completeAny, returnDelivery, finishPass, synchronize, crash, idle }

  val typeOK = all {
    state.requested.subseteq(actors), state.snapshot.subseteq(state.requested),
    state.remaining._1.in(0.to(2)), state.remaining._2.in(0.to(2)), state.staged.in(Set(-1, 0, 1)),
    state.staged != -1 implies not(state.requested.contains(state.staged)),
    actors.forall(actor => not(state.requested.contains(actor)) implies count(state, actor) == 0),
    state.phase.in(Set("idle", "arming", "driving", "finishing")),
    state.phase == "idle" implies state.snapshot == Set(),
    state.retryLimit.in(Set(-1, 2)), state.retriesLeft.in(Set(-1, 0, 1, 2)),
  }
  val wakeCoverage = pending(state).size() > 0 implies state.wake or state.retrying or state.phase != "idle"
  val coveredBeforeEffects = state.phase == "driving" implies state.wake
  val invariant = all {
    typeOK, state.atomicAdmission, state.renewWatchdog, state.preserveLaterWake, state.platformRetries,
    state.retryLimit == -1, state.retriesLeft == -1,
    wakeCoverage, coveredBeforeEffects,
    state.phase == "arming" implies state.retrying,
    state.phase == "finishing" implies state.snapshot.forall(actor => count(state, actor) == 0),
  }

  temporal fairPlatform = fire.weakFair(state) and redeliver.weakFair(state)
  temporal fairExecution = armRecovery.weakFair(state) and completeEffect(0).weakFair(state)
    and completeEffect(1).weakFair(state) and finishPass.weakFair(state) and synchronize.weakFair(state)
  temporal eventualQuiet = eventually(always(not(state.crashed)))
  temporal eventualSettlement = (fairPlatform and fairExecution and eventualQuiet) implies
    (state.requested.contains(0).leadsTo(count(state, 0) == 0)
      and state.requested.contains(1).leadsTo(count(state, 1) == 0))

  run strandedAfterCrashTest = initWithoutAdmissionWake.then(stage(0)).then(receive).then(crash)
    .then(idle).expect(pending(state) == Set(0) and not(wakeCoverage))
  run missingRenewalTest = initWithoutRenewal.then(stage(0)).then(receive).then(fire).then(armRecovery)
    .then(returnDelivery).then(crash).expect(pending(state) == Set(0) and not(wakeCoverage))
  run crashBeforeCommitTest = init.then(stage(0)).then(crash).expect(state.requested == Set() and invariant)
  run crashBeforeRearmTest = init.then(stage(0)).then(receive).then(fire).then(crash).expect(state.retrying and invariant)
  run crashAfterRearmTest = init.then(stage(0)).then(receive).then(fire).then(armRecovery).then(crash).expect(state.wake and invariant)
  run recoveryTest = init.then(stage(0)).then(receive).then(fire).then(armRecovery).then(completeEffect(0))
    .then(returnDelivery).then(crash).then(fire).then(armRecovery).then(completeEffect(0)).then(finishPass).then(synchronize)
    .expect(count(state, 0) == 0 and not(state.wake) and invariant)
  run missingPlatformRetryTest = initWithoutRetry.then(stage(0)).then(receive).then(fire).then(crash).expect(not(wakeCoverage))
  run exhaustedRetryTest = initFiniteRetry.then(stage(0)).then(receive).then(fire).then(crash)
    .then(redeliver).then(crash).then(redeliver).then(crash).then(idle)
    .expect(state.retriesLeft == 0 and pending(state) == Set(0) and not(wakeCoverage))
  run staleClearTest = initStaleClear.then(stage(0)).then(receive).then(fire).then(armRecovery)
    .then(completeEffect(0)).then(completeEffect(0)).then(finishPass).then(stage(1)).then(receive)
    .then(synchronize).expect(pending(state) == Set(1) and not(wakeCoverage))
  run laterAdmissionTest = init.then(stage(0)).then(receive).then(fire).then(armRecovery)
    .then(completeEffect(0)).then(completeEffect(0)).then(finishPass).then(stage(1)).then(receive)
    .then(synchronize).expect(state.wake and invariant)
}
