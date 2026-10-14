// operationRecovery connects accepted input, late handles, cleanup, and watchdog coverage (invariant).
// Crash discards a local cleanup attempt; durable input, handles, and wake coverage survive.
// Remote submission must finish before process loss; recovering an unknown external handle requires executor idempotency outside this model.
// Clock durations, byte codecs, and TypeScript refinement are outside this finite instance.
module operationRecovery {
  type State = {
    accepted: bool, input: bool, execution: str, cleanup: str,
    producer: bool, created: bool, handle: bool, cleaned: bool,
    wake: bool, online: bool, child: str,
  }
  pure val initial: State = {
    accepted: false, input: false, execution: "pending", cleanup: "none",
    producer: false, created: false, handle: false, cleaned: false,
    wake: false, online: true, child: "none",
  }
  var state: State
  pure def cleanupOwed(s: State): bool = s.cleanup.in(Set("pending", "running", "retry", "blocked"))
  pure def runnable(s: State): bool = s.execution == "pending" or s.cleanup.in(Set("pending", "running", "retry")) or s.producer or s.child == "pending"
  pure def needsInput(s: State): bool = s.execution == "pending" or cleanupOwed(s) or s.producer or s.child.in(Set("waiting", "pending"))
  pure def accept(s: State): State = s.with("accepted", true).with("input", true).with("wake", true)
  pure def begin(s: State): State = s.with("producer", true)
  pure def finish(s: State): State = s.with("execution", "done")
  pure def cancel(s: State): State = s.with("execution", "cancelled").with("cleanup", "pending")
  pure def cancelWithChild(s: State): State = cancel(s).with("child", "waiting")
  pure def forward(s: State): State = s.with("child", "pending")
  pure def finishChild(s: State): State = s.with("child", "done")
  pure def die(s: State): State = s.with("execution", "died")
  pure def submit(s: State): State = s.with("producer", false).with("created", true).with("handle", true)
  pure def startCleanup(s: State): State = s.with("cleanup", "running")
  pure def retry(s: State): State = s.with("cleanup", "retry")
  pure def block(s: State): State = s.with("cleanup", "blocked").with("wake", s.child == "pending")
  pure def succeed(s: State): State = s.with("cleanup", "done").with("cleaned", s.handle)
  pure def release(s: State): State = s.with("input", false).with("wake", false)
  pure def crash(s: State): State = s.with("online", false).with("cleanup", if (s.cleanup == "running") "pending" else s.cleanup)
  pure def recover(s: State): State = s.with("online", true)
  action init = state' = initial
  action step = any {
    all { not(state.accepted), state' = accept(state) },
    all { state.online, state.accepted, state.execution == "pending", not(state.producer), not(state.created), state' = begin(state) },
    all { state.online, state.accepted, state.execution == "pending", not(state.producer), state' = finish(state) },
    all { state.online, state.accepted, state.execution == "pending", state.cleanup == "none", state' = cancel(state) },
    all { state.online, state.accepted, state.execution == "pending", state.cleanup == "none", state' = cancelWithChild(state) },
    all { state.online, state.cleanup == "running", state.child == "waiting", state' = forward(state) },
    all { state.online, state.child == "pending", state' = finishChild(state) },
    all { state.online, state.accepted, state.cleanup != "none", state.execution == "cancelled", state' = die(state) },
    all { state.online, state.producer, state' = submit(state) },
    all { state.online, state.cleanup.in(Set("pending", "retry")), not(state.producer), state' = startCleanup(state) },
    all { state.online, state.cleanup == "running", state' = retry(state) },
    all { state.online, state.cleanup == "running", state' = block(state) },
    all { state.online, state.cleanup == "running", state.child != "waiting", state' = succeed(state) },
    all { state.accepted, not(needsInput(state)), state' = release(state) },
    all { state.accepted, state.online, not(state.producer), state' = crash(state) },
    all { not(state.online), state.wake, state' = recover(state) },
    state' = state,
  }
  pure def retained(s: State): bool = s.accepted and needsInput(s) implies s.input
  pure def covered(s: State): bool = s.accepted and runnable(s) implies s.wake
  pure def handleAdmitted(s: State): bool = s.created implies s.handle
  pure def cleanupComplete(s: State): bool = s.cleanup == "done" implies not(s.producer) and (not(s.created) or s.cleaned) and s.child != "waiting"
  val invariant = retained(state) and covered(state) and handleAdmitted(state) and cleanupComplete(state)

  action stepDropsWake = any { step, all { state.cleanup == "running", state' = state.with("wake", false) } }
  action stepBlocksCleanupOnDeath = any { step, all { cleanupOwed(state), state.execution == "died", state' = state.with("wake", false) } }
  action stepDropsLateHandle = any { step, all { state.producer, state.execution == "died", state' = submit(state).with("handle", false) } }

  run normalLifecycleTest = init.then(state' = accept(state)).then(state' = begin(state)).then(state' = submit(state))
    .then(state' = crash(state)).then(state' = recover(state)).then(state' = finish(state)).then(state' = release(state))
    .expect(invariant and not(state.input) and not(state.wake))
  run fullLifecycleTest = init.then(state' = accept(state)).then(state' = begin(state)).then(state' = cancelWithChild(state))
    .then(state' = die(state)).then(state' = submit(state)).then(state' = startCleanup(state))
    .then(state' = retry(state)).then(state' = crash(state)).then(state' = recover(state))
    .then(state' = startCleanup(state)).then(state' = forward(state)).then(state' = finishChild(state)).then(state' = succeed(state)).then(state' = release(state))
    .expect(invariant and not(state.input) and state.cleaned and not(state.wake))
  run activeCleanupWakeTest = init.then(state' = accept(state)).then(state' = cancel(state)).then(state' = startCleanup(state))
    .then(state' = state.with("wake", false)).expect(not(covered(state)))
  run deathPreservesCleanupTest = init.then(state' = accept(state)).then(state' = cancel(state)).then(state' = die(state))
    .expect(invariant and cleanupOwed(state) and runnable(state))
  run droppedHandleTest = init.then(state' = accept(state)).then(state' = begin(state)).then(state' = cancel(state))
    .then(state' = die(state)).then(state' = submit(state).with("handle", false)).expect(not(handleAdmitted(state)))
}
