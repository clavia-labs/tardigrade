// attemptDeadline checks default and configurable deadlines inside the durable retry boundary (invariant, attemptsEnd).
// Local interruption precedes a retry decision; a lost response supplies no remote-stop acknowledgement.
// The receiver deduplicates by stable identity and input; crash is modeled between attempts.
// Arbitrary finalizers, decision callbacks, process loss during an attempt, and TypeScript refinement are outside this instance.
module attemptDeadline {
  type State = {
    kind: str, input: bool, phase: str, elapsed: bool, online: bool,
    retries: int, remoteAccepted: bool, remoteStopped: bool,
    localStopped: bool, result: str, dispatched: Set[int], proposal: int,
    producer: bool, handle: bool, deadline: bool,
  }
  var state: State
  pure def initial(kind: str, producer: bool): State = {
    kind: kind, input: true, phase: "ready", elapsed: false, online: true,
    retries: 0, remoteAccepted: kind == "cleanup", remoteStopped: false,
    localStopped: true, result: "", dispatched: Set(), proposal: 0,
    producer: producer, handle: kind == "cleanup" and not(producer), deadline: true,
  }
  action init = {
    nondet kind = Set("execution", "cleanup").oneOf()
    nondet producer = Set(false, true).oneOf()
    state' = initial(kind, kind == "cleanup" and producer)
  }
  action disableDeadline = all { state.phase == "ready", state' = state.with("deadline", false) }
  action begin = all {
    state.online, state.phase == "ready", state.input, state.localStopped,
    state' = state.with("phase", "running").with("elapsed", false).with("localStopped", false)
      .with("result", "").with("dispatched", state.dispatched.union(Set(0))),
  }
  action acceptRemote = all {
    state.online, state.phase == "running", not(state.remoteAccepted),
    state' = state.with("remoteAccepted", true),
  }
  action tick = all {
    state.online, state.phase == "running", not(state.elapsed),
    state' = state.with("elapsed", true),
  }
  action expire = all {
    state.online, state.phase == "running", state.elapsed, state.deadline,
    state' = state.with("phase", "stopping").with("result", "timeout"),
  }
  action interrupt = all {
    state.online, state.phase == "stopping",
    state' = state.with("phase", "decision").with("localStopped", true),
  }
  action reject = all {
    state.online, state.phase == "running",
    state' = state.with("phase", "decision").with("localStopped", true).with("result", "failure"),
  }
  action succeed = all {
    state.online, state.phase == "running", not(state.producer),
    state' = state.with("phase", "done").with("localStopped", true).with("result", "success")
      .with("remoteStopped", state.kind == "cleanup" or state.remoteStopped),
  }
  // decide records the retry count before waiting; a final cleanup rejection retains its input.
  action scheduleRetry = all {
    state.online, state.phase == "decision", state.retries < 1,
    state' = state.with("phase", "retry").with("retries", state.retries + 1),
  }
  action stop = all {
    state.online, state.phase == "decision",
    state' = state.with("phase", if (state.kind == "execution") "done" else "blocked"),
  }
  action decide = any { scheduleRetry, stop }
  action wake = all { state.online, state.phase == "retry", state' = state.with("phase", "ready") }
  action handoff = all { state.online, state.producer, state' = state.with("producer", false).with("handle", true) }
  action crash = all { state.online, not(state.producer), state.phase.in(Set("retry", "done", "blocked")), state' = state.with("online", false) }
  action reopen = all { not(state.online), state' = state.with("online", true).with("proposal", 1) }
  action release = all { state.phase == "done", not(state.producer), state' = state.with("input", false) }
  action hold = state' = state
  action step = any { disableDeadline, begin, acceptRemote, tick, expire, interrupt, reject, succeed, decide, wake, handoff, crash, reopen, release, hold }

  val retained = state.phase != "done" implies state.input
  val identityStable = state.dispatched.subseteq(Set(0))
  val noOverlap = state.phase.in(Set("ready", "decision", "retry", "done", "blocked")) implies state.localStopped
  val cleanupDischargeSound = state.kind == "cleanup" and state.phase == "done" implies state.result == "success" and state.remoteStopped
  val handleRetained = state.kind == "cleanup" and not(state.producer) implies state.handle
  val invariant = retained and identityStable and noOverlap and cleanupDischargeSound and handleRetained and state.retries.in(0.to(1))
  temporal fairAttempts = eventually(always(state.online))
    and tick.weakFair(state) and expire.weakFair(state) and interrupt.weakFair(state) and decide.weakFair(state)
  temporal attemptsEnd = fairAttempts implies (state.phase == "running" and state.deadline).leadsTo(state.localStopped)

  action stepEarlyRelease = any { step, all { state.phase != "done", state' = state.with("input", false) } }
  action stepTimeoutDischargesCleanup = any { step, all {
    state.kind == "cleanup", state.phase == "decision", state.result == "timeout", state' = state.with("phase", "done"),
  } }
  action stepDropsLateHandle = any { step, all { state.online, state.producer, state' = state.with("producer", false) } }
  run executionTimeoutRetryTest = (state' = initial("execution", false)).then(begin).then(acceptRemote).then(tick).then(expire)
    .expect(invariant and state.remoteAccepted and not(state.remoteStopped) and not(state.localStopped))
    .then(interrupt).then(scheduleRetry).then(crash).then(reopen).then(wake).then(begin)
    .expect(invariant and state.retries == 1 and state.proposal == 1 and state.dispatched == Set(0))
    .then(succeed).then(release).expect(invariant and not(state.input))
  run cleanupTimeoutRetryTest = (state' = initial("cleanup", false)).then(begin).then(tick).then(expire)
    .then(interrupt).then(scheduleRetry).then(crash).then(reopen).then(wake).then(begin)
    .then(succeed).then(release).expect(invariant and state.remoteStopped and not(state.input))
  run timeoutStopsTest = (state' = initial("cleanup", false)).then(begin).then(tick).then(expire).then(interrupt)
    .then(stop).then(crash).then(reopen)
    .expect(invariant and (state.kind == "cleanup" implies state.input and state.phase == "blocked"))
  run unboundedAttemptTest = (state' = initial("execution", false)).then(disableDeadline).then(begin).then(acceptRemote).then(tick).then(hold)
    .expect(invariant and state.phase == "running" and not(state.localStopped))
  run interruptedBeforeDecisionTest = init.then(begin).then(tick).then(expire)
    .expect(invariant and state.phase == "stopping" and not(state.localStopped))
  run cleanupProducerTimeoutTest = (state' = initial("cleanup", true)).then(begin).then(tick).then(expire).then(interrupt)
    .then(stop).expect(invariant and state.producer and state.phase == "blocked")
    .then(handoff).expect(invariant and state.handle and state.input and not(state.remoteStopped))
}
