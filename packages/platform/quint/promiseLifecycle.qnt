// promiseLifecycle models submitted handles, durable completion buffers, fibre supervision, and promise deadlines (invariant, eventualSettlement).
// Time abstracts arrival at a persisted deadline; actor recovery, deadline processing, and result delivery are weakly fair.
// Timeout rejects the promise without claiming that remote work was aborted; executor cleanup is outside this model.
module promiseLifecycle {
  type State = {
    mode: str, submitted: bool, online: bool, crashed: bool, restored: bool,
    fibre: str, fibreExited: bool, owner: bool, watchdog: bool, deadlineWake: bool,
    expired: bool, deadlineGeneration: int, sourceResult: str, accepted: bool,
    terminal: str, decisions: Set[str], terminalWrites: int, processed: bool, blocked: bool, attempts: int, renewals: int,
    localDeadline: bool, renewExpiry: bool, replayExpired: bool, restartedExpired: bool,
    supervise: bool, durableResults: bool, atomicHandoff: bool, separateWakes: bool,
    parkRemote: bool, stableDeadline: bool, firstTerminal: bool,
  }
  pure def initial(mode: str): State = {
    mode: mode, submitted: false, online: true, crashed: false, restored: true,
    fibre: if (mode == "local") "running" else "absent", fibreExited: false,
    owner: false, watchdog: true, deadlineWake: false, expired: false, deadlineGeneration: 0,
    sourceResult: "", accepted: false, terminal: "", decisions: Set(), terminalWrites: 0,
    processed: false, blocked: false, attempts: 0, renewals: 0,
    localDeadline: true, renewExpiry: true, replayExpired: false, restartedExpired: false,
    supervise: true, durableResults: true, atomicHandoff: true, separateWakes: true,
    parkRemote: true, stableDeadline: true, firstTerminal: true,
  }
  var state: State
  action init = { nondet mode = Set("local", "remote").oneOf(); state' = initial(mode) }
  action initUnsupervised = state' = initial("local").with("supervise", false)
  action initVolatileResult = state' = initial("remote").with("durableResults", false)
  action initEarlyPark = state' = initial("remote").with("atomicHandoff", false)
  action initSharedClear = state' = initial("remote").with("separateWakes", false)
  action initRemotePolling = state' = initial("remote").with("parkRemote", false)
  action initResetDeadline = state' = initial("local").with("stableDeadline", false)
  action initOverwriteTerminal = state' = initial("remote").with("firstTerminal", false)

  action initMissingLocalDeadline = state' = initial("local").with("localDeadline", false)
  action initWithoutExpiryAdmission = state' = initial("local").with("renewExpiry", false)
  action initExpiredReplay = state' = initial("local").with("replayExpired", true)

  // submit records EffectSettled with a promise handle without settling the promise itself.
  action submit = all {
    state.online, not(state.submitted),
    state' = state.with("submitted", true)
      .with("owner", state.mode == "local" and state.localDeadline)
      .with("deadlineWake", state.mode == "local" and state.localDeadline),
  }
  // register atomically hands a remote wait to durable completion and expiry ownership before parking recovery.
  action register = all {
    state.online, state.submitted, state.mode == "remote", state.terminal == "", not(state.owner),
    state' = state.with("owner", true).with("deadlineWake", state.separateWakes)
      .with("watchdog", not(state.parkRemote)),
  }
  action parkEarly = all {
    not(state.atomicHandoff), state.online, state.submitted, state.mode == "remote", not(state.owner), state.terminal == "",
    state' = state.with("watchdog", false),
  }
  // complete accepts a buffered result independently of whether the submission or waiter is ready.
  action complete = all {
    state.sourceResult == "", state.mode == "remote" or (state.online and state.fibre == "running"),
    state' = state.with("sourceResult", "fulfilled").with("accepted", true)
      .with("fibre", if (state.mode == "local") "done" else state.fibre),
  }
  action failFibre = all {
    state.online, state.mode == "local", state.fibre == "running", state.terminal == "",
    state' = state.with("fibre", "dead").with("fibreExited", true)
      .with("sourceResult", if (state.supervise) "failed" else state.sourceResult)
      .with("accepted", state.accepted or state.supervise),
  }
  // settle represents the serialized durable decision shared by completion, failure, and timeout.
  action settle(value: str): bool = {
    val needsProcessing = state.mode == "local" and value == "timeout"
    val renew = needsProcessing and state.blocked and state.renewExpiry
    if (state.firstTerminal and state.terminal != "") state' = state
    else state' = state.with("terminal", value).with("decisions", state.decisions.union(Set(value)))
      .with("terminalWrites", if (state.terminalWrites < 2) state.terminalWrites + 1 else 2)
      .with("watchdog", needsProcessing and (not(state.blocked) or renew)).with("deadlineWake", false)
      .with("processed", not(needsProcessing)).with("blocked", state.blocked and not(renew))
      .with("attempts", if (renew) 0 else state.attempts)
      .with("renewals", state.renewals + (if (renew) 1 else 0))
  }
  action processTimeout = all {
    state.online, state.terminal == "timeout", not(state.processed), not(state.blocked), state.watchdog,
    state' = state.with("processed", true).with("watchdog", false),
  }
  // failRecovery abstracts crashes before a producer can be restored, with two attempts per budget.
  action failRecovery = all {
    state.online, state.mode == "local", state.submitted, state.terminal == "", not(state.expired),
    state.fibre == "absent", not(state.blocked), state.watchdog, state.attempts < 2,
    state' = state.with("attempts", state.attempts + 1)
      .with("blocked", state.attempts == 1).with("watchdog", state.attempts != 1),
  }
  action deliverSource = all {
    state.online, state.submitted, state.sourceResult != "", settle(state.sourceResult),
  }
  action tick = all { not(state.expired), state' = state.with("expired", true) }
  action expire = all {
    state.online, state.submitted, state.expired, state.watchdog or state.deadlineWake,
    settle("timeout"),
  }
  action crash = state' = state.with("online", false).with("crashed", true).with("restored", false).with("fibre", "absent")
    .with("sourceResult", if (state.durableResults) state.sourceResult else "")
  action reopen = all { not(state.online), state' = state.with("online", true).with("crashed", false) }
  // restore reconstructs local replay-safe work using the original deadline; replay eligibility is checked in invocationReplay.qnt.
  action restore = {
    val restart = state.mode == "local" and state.sourceResult == "" and not(state.blocked)
      and (not(state.expired) or state.replayExpired)
    all {
      state.online, not(state.restored), state.terminal == "",
      state' = state.with("restored", true).with("fibre", if (restart) "running" else "absent")
        .with("restartedExpired", state.restartedExpired or (restart and state.expired))
        .with("expired", state.expired and state.stableDeadline)
        .with("deadlineGeneration", if (state.stableDeadline) state.deadlineGeneration else 1),
    }
  }
  action idle = state' = state.with("crashed", false)
  action step = any { submit, register, parkEarly, complete, failFibre, deliverSource, tick, expire, crash, reopen, restore, failRecovery, processTimeout, idle }

  val typeOK = all {
    state.mode.in(Set("local", "remote")), state.fibre.in(Set("absent", "running", "done", "dead")),
    state.sourceResult.in(Set("", "fulfilled", "failed")), state.terminal.in(Set("", "fulfilled", "failed", "timeout")),
    state.decisions.subseteq(Set("fulfilled", "failed", "timeout")), state.deadlineGeneration.in(0.to(1)),
    not(state.online) implies state.fibre == "absent",
    state.terminal != "" implies state.submitted,
    state.attempts.in(0.to(2)), state.renewals.in(0.to(1)), state.terminalWrites.in(0.to(2)),
  }
  val pendingCoverage = state.terminal == "" implies state.watchdog or (state.owner and state.deadlineWake)
  val completionDurable = state.accepted implies state.sourceResult != "" or state.terminal != ""
  val fibreExitAccounted = state.fibreExited and state.terminal == "" implies state.sourceResult != ""
  val deadlineStable = state.deadlineGeneration == 0
  val firstDecisionWins = state.decisions.size() <= 1 and state.terminalWrites <= 1
  val noRemoteBurn = state.mode == "remote" and state.owner and state.terminal == "" implies not(state.watchdog)
  val alarmSet = (if (state.watchdog) Set("watchdog") else Set()).union(if (state.deadlineWake) Set("promise") else Set())
  val physicalAlarm = alarmSet.size() > 0
  val blockedDeadlineCoverage = state.submitted and state.terminal == "" and state.blocked implies
    state.deadlineWake and physicalAlarm and not(state.watchdog)
  val timeoutAdmission = state.terminal == "timeout" and not(state.processed) implies not(state.blocked) and state.watchdog
  val expiryRenewal = state.renewals > 0 implies state.terminal == "timeout"
  val noExpiredReplay = not(state.restartedExpired)
  val terminalQuiet = state.terminal != "" implies not(state.deadlineWake) and (state.processed implies not(state.watchdog))
  val invariant = all { typeOK, pendingCoverage, completionDurable, fibreExitAccounted, deadlineStable, firstDecisionWins, noRemoteBurn, terminalQuiet, blockedDeadlineCoverage, timeoutAdmission, expiryRenewal, noExpiredReplay }
  temporal fairService = submit.weakFair(state) and register.weakFair(state) and deliverSource.weakFair(state)
    and tick.weakFair(state) and expire.weakFair(state) and reopen.weakFair(state) and restore.weakFair(state) and processTimeout.weakFair(state)
  temporal eventualQuiet = eventually(always(state.online and not(state.crashed)))
  temporal eventualSettlement = (fairService and eventualQuiet) implies
    (state.terminal == "").leadsTo(state.terminal != "")
  temporal eventualProcessing = (fairService and eventualQuiet) implies
    (state.terminal == "timeout").leadsTo(state.processed)
  temporal terminalStable = always((state.terminal == "fulfilled" implies always(state.terminal == "fulfilled"))
    and (state.terminal == "failed" implies always(state.terminal == "failed"))
    and (state.terminal == "timeout" implies always(state.terminal == "timeout")))

  run blockedDeadlineTest = (state' = initial("local")).then(submit).then(crash).then(reopen)
    .then(failRecovery).then(failRecovery)
    .expect(state.blocked and alarmSet == Set("promise") and invariant)
    .then(crash).then(tick).then(reopen).then(restore).then(expire)
    .expect(state.terminal == "timeout" and state.renewals == 1 and state.attempts == 0 and invariant)
    .then(crash).then(reopen).then(expire).then(processTimeout)
    .expect(state.processed and state.terminalWrites == 1 and state.renewals == 1 and alarmSet == Set() and firstDecisionWins and invariant)
  run missingLocalDeadlineTest = initMissingLocalDeadline.then(submit).then(crash).then(reopen)
    .then(failRecovery).then(failRecovery).expect(not(blockedDeadlineCoverage) and not(physicalAlarm))
  run missingExpiryAdmissionTest = initWithoutExpiryAdmission.then(submit).then(crash).then(reopen)
    .then(failRecovery).then(failRecovery).then(tick).then(expire).expect(not(timeoutAdmission))
  run expiredReplayTest = initExpiredReplay.then(submit).then(crash).then(tick).then(reopen).then(restore)
    .expect(not(noExpiredReplay))

  run parkedRemoteTest = (state' = initial("remote")).then(submit).then(register)
    .expect(state.submitted and state.terminal == "" and state.deadlineWake and not(state.watchdog) and invariant)
  run earlyCompletionTest = (state' = initial("local")).then(complete).then(submit).then(deliverSource)
    .expect(state.terminal == "fulfilled" and invariant)
  run fibreFailureTest = (state' = initial("local")).then(submit).then(failFibre).then(deliverSource)
    .expect(state.terminal == "failed" and invariant)
  run missingSupervisionTest = initUnsupervised.then(submit).then(failFibre).expect(not(fibreExitAccounted))
  run timeoutWithoutAbortTest = (state' = initial("remote")).then(submit).then(register).then(tick).then(expire)
    .then(complete).then(deliverSource).expect(state.terminal == "timeout" and firstDecisionWins and terminalQuiet)
  run lateTimeoutTest = (state' = initial("remote")).then(submit).then(register).then(complete).then(deliverSource)
    .then(tick).expect(state.terminal == "fulfilled" and firstDecisionWins and terminalQuiet)
  run lostCompletionTest = initVolatileResult.then(submit).then(register).then(complete).then(crash)
    .expect(not(completionDurable))
  run sharedAlarmClearTest = initSharedClear.then(submit).then(register).expect(not(pendingCoverage))
  run earlyParkTest = initEarlyPark.then(submit).then(parkEarly).expect(not(pendingCoverage))
  run overwrittenTimeoutTest = initOverwriteTerminal.then(submit).then(register).then(tick).then(expire)
    .then(complete).then(deliverSource).expect(not(firstDecisionWins))
  run restartedDeadlineTest = initResetDeadline.then(submit).then(tick).then(crash).then(reopen).then(restore)
    .expect(not(deadlineStable) and not(state.expired))
}
