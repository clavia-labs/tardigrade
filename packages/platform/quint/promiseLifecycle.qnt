// promiseLifecycle models submitted handles, durable completion buffers, fibre supervision, and promise deadlines (invariant, eventualSettlement).
// Time abstracts arrival at a persisted deadline; actor recovery, deadline processing, and result delivery are weakly fair.
// Timeout rejects the promise without claiming that remote work was aborted; executor cleanup is outside this model.
module promiseLifecycle {
  type State = {
    mode: str, submitted: bool, online: bool, crashed: bool, restored: bool,
    fibre: str, fibreExited: bool, owner: bool, watchdog: bool, deadlineWake: bool,
    expired: bool, deadlineGeneration: int, sourceResult: str, accepted: bool,
    terminal: str, decisions: Set[str],
    supervise: bool, durableResults: bool, atomicHandoff: bool, separateWakes: bool,
    parkRemote: bool, stableDeadline: bool, firstTerminal: bool,
  }
  pure def initial(mode: str): State = {
    mode: mode, submitted: false, online: true, crashed: false, restored: true,
    fibre: if (mode == "local") "running" else "absent", fibreExited: false,
    owner: false, watchdog: true, deadlineWake: false, expired: false, deadlineGeneration: 0,
    sourceResult: "", accepted: false, terminal: "", decisions: Set(),
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

  // submit records EffectSettled with a promise handle without settling the promise itself.
  action submit = all { state.online, not(state.submitted), state' = state.with("submitted", true) }
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
  action settle(value: str): bool =
    if (state.firstTerminal and state.terminal != "") state' = state
    else state' = state.with("terminal", value).with("decisions", state.decisions.union(Set(value)))
      .with("watchdog", false).with("deadlineWake", false)
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
  action restore = all {
    state.online, not(state.restored), state.terminal == "",
    state' = state.with("restored", true)
      .with("fibre", if (state.mode == "local" and state.sourceResult == "") "running" else "absent")
      .with("expired", state.expired and state.stableDeadline)
      .with("deadlineGeneration", if (state.stableDeadline) state.deadlineGeneration else 1),
  }
  action idle = state' = state.with("crashed", false)
  action step = any { submit, register, parkEarly, complete, failFibre, deliverSource, tick, expire, crash, reopen, restore, idle }

  val typeOK = all {
    state.mode.in(Set("local", "remote")), state.fibre.in(Set("absent", "running", "done", "dead")),
    state.sourceResult.in(Set("", "fulfilled", "failed")), state.terminal.in(Set("", "fulfilled", "failed", "timeout")),
    state.decisions.subseteq(Set("fulfilled", "failed", "timeout")), state.deadlineGeneration.in(0.to(1)),
    not(state.online) implies state.fibre == "absent",
    state.terminal != "" implies state.submitted,
  }
  val pendingCoverage = state.terminal == "" implies state.watchdog or (state.owner and state.deadlineWake)
  val completionDurable = state.accepted implies state.sourceResult != "" or state.terminal != ""
  val fibreExitAccounted = state.fibreExited and state.terminal == "" implies state.sourceResult != ""
  val deadlineStable = state.deadlineGeneration == 0
  val firstDecisionWins = state.decisions.size() <= 1
  val noRemoteBurn = state.mode == "remote" and state.owner and state.terminal == "" implies not(state.watchdog)
  val terminalQuiet = state.terminal != "" implies not(state.watchdog) and not(state.deadlineWake)
  val invariant = all { typeOK, pendingCoverage, completionDurable, fibreExitAccounted, deadlineStable, firstDecisionWins, noRemoteBurn, terminalQuiet }
  temporal fairService = submit.weakFair(state) and register.weakFair(state) and deliverSource.weakFair(state)
    and tick.weakFair(state) and expire.weakFair(state) and reopen.weakFair(state) and restore.weakFair(state)
  temporal eventualQuiet = eventually(always(state.online and not(state.crashed)))
  temporal eventualSettlement = (fairService and eventualQuiet) implies
    (state.terminal == "").leadsTo(state.terminal != "")
  temporal terminalStable = always((state.terminal == "fulfilled" implies always(state.terminal == "fulfilled"))
    and (state.terminal == "failed" implies always(state.terminal == "failed"))
    and (state.terminal == "timeout" implies always(state.terminal == "timeout")))

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
