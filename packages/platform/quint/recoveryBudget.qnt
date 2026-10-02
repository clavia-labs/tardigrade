// recoveryBudget models durable attempt accounting, fibre deadlines, and poison work (boundedAttempts, eventualStop).
// Alarm consumption, attempt accounting, and rearming are atomic here; watchdog.qnt exposes the platform retry gap.
// Fair alarm delivery and attempt timers are assumed; execution can fail, hang, or crash without eventually succeeding.
module recoveryBudget {
  type State = {
    work: str, status: str, wake: bool, running: bool, age: int, terminalSeen: bool,
    attempts: int, noProgress: int, actualAttempts: int,
    precharge: bool, durableBudget: bool, resetTotal: bool, stopTerminal: bool, extendLiveDeadline: bool,
  }
  pure val maxAttempts = 3
  pure val maxNoProgress = 2
  pure val attemptDeadline = 2
  pure def initial(work: str): State = {
    work: work, status: "pending", wake: true, running: false, age: 0, terminalSeen: false,
    attempts: 0, noProgress: 0, actualAttempts: 0,
    precharge: true, durableBudget: true, resetTotal: false, stopTerminal: true, extendLiveDeadline: false,
  }
  var state: State
  action init = {
    nondet work = Set("finite", "retry", "progress", "terminal", "hung").oneOf()
    state' = initial(work)
  }
  action initPostcharge = state' = initial("retry").with("precharge", false)
  action initVolatileBudget = state' = initial("retry").with("durableBudget", false)
  action initResetTotal = state' = initial("progress").with("resetTotal", true)
  action initRetryTerminal = state' = initial("terminal").with("stopTerminal", false)
  action initExtendLiveDeadline = state' = initial("hung").with("extendLiveDeadline", true)

  // fire accounts for an attempt and persists its replacement before permitting execution.
  action fire = all {
    state.status == "pending", state.wake, not(state.running),
    if (state.attempts >= maxAttempts or state.noProgress >= maxNoProgress)
      state' = state.with("status", "blocked").with("wake", false)
    else state' = state.with("running", true).with("age", 0)
      .with("attempts", state.attempts + (if (state.precharge) 1 else 0))
      .with("noProgress", state.noProgress + (if (state.precharge) 1 else 0))
      .with("actualAttempts", if (state.actualAttempts <= maxAttempts) state.actualAttempts + 1 else state.actualAttempts),
  }
  action tick = all {
    state.running, state.age < attemptDeadline,
    state' = state.with("age", state.age + 1),
  }
  action succeed = all {
    state.running, state.work == "finite",
    state' = state.with("status", "settled").with("wake", false).with("running", false),
  }
  action retryFailure = all {
    state.running, state.work == "retry",
    state' = state.with("running", false)
      .with("attempts", state.attempts + (if (state.precharge) 0 else 1))
      .with("noProgress", state.noProgress + (if (state.precharge) 0 else 1)),
  }
  // progress represents durable movement that still enables more work; it cannot replenish the total budget.
  action progress = all {
    state.running, state.work == "progress",
    state' = state.with("running", false).with("noProgress", 0)
      .with("attempts", if (state.resetTotal) 0 else state.attempts),
  }
  action terminalFailure = all {
    state.running, state.work == "terminal",
    state' = state.with("running", false).with("terminalSeen", true)
      .with("status", if (state.stopTerminal) "blocked" else "pending")
      .with("wake", not(state.stopTerminal)),
  }
  action expireAttempt = all {
    state.running, state.age == attemptDeadline,
    state' = state.with("running", false),
  }
  // probe observes a live fibre without starting another attempt or extending its deadline.
  action probe = all {
    state.running, state.wake,
    state' = state.with("age", if (state.extendLiveDeadline) 0 else state.age),
  }
  action crash = state' = state.with("running", false)
    .with("attempts", if (state.durableBudget) state.attempts else 0)
    .with("noProgress", if (state.durableBudget) state.noProgress else 0)
  action idle = state' = state
  action step = any { fire, tick, succeed, retryFailure, progress, terminalFailure, expireAttempt, probe, crash, idle }

  val typeOK = all {
    state.work.in(Set("finite", "retry", "progress", "terminal", "hung")),
    state.status.in(Set("pending", "settled", "blocked")),
    state.attempts.in(0.to(maxAttempts)), state.noProgress.in(0.to(maxNoProgress)),
    state.actualAttempts.in(0.to(maxAttempts + 1)), state.age.in(0.to(attemptDeadline)),
  }
  val boundedAttempts = state.actualAttempts <= maxAttempts
  val wakeCoverage = state.status == "pending" implies state.wake
  val stoppedMeansQuiet = state.status != "pending" implies not(state.wake) and not(state.running)
  val terminalStops = state.terminalSeen implies state.status == "blocked"
  val invariant = all { typeOK, boundedAttempts, wakeCoverage, stoppedMeansQuiet, terminalStops }
  temporal fairService = fire.weakFair(state) and tick.weakFair(state) and expireAttempt.weakFair(state)
  temporal eventualStop = fairService implies (state.status == "pending").leadsTo(state.status != "pending")

  run crashBudgetTest = initVolatileBudget.then(fire).then(crash).then(fire).then(crash)
    .then(fire).then(crash).then(fire).expect(not(boundedAttempts))
  run postchargeTest = initPostcharge.then(fire).then(crash).then(fire).then(crash)
    .then(fire).then(crash).then(fire).expect(not(boundedAttempts))
  run progressingPoisonTest = initResetTotal.then(fire).then(progress).then(fire).then(progress)
    .then(fire).then(progress).then(fire).expect(not(boundedAttempts))
  run boundedCrashTest = (state' = initial("retry")).then(fire).then(crash).then(fire).then(crash)
    .then(fire).expect(state.status == "blocked" and stoppedMeansQuiet and invariant)
  run hungFibreTest = (state' = initial("hung")).then(fire).then(probe).then(tick).then(probe).then(tick)
    .then(expireAttempt).expect(state.attempts == 1 and not(state.running) and state.age == attemptDeadline)
  run terminalFailureTest = (state' = initial("terminal")).then(fire).then(terminalFailure)
    .expect(state.status == "blocked" and stoppedMeansQuiet)
  run extendedDeadlineTest = initExtendLiveDeadline.then(fire).then(tick).then(probe)
    .expect(state.running and state.age == 0 and state.attempts == 1)
}
