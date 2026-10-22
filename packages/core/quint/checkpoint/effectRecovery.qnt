// effectRecovery models unfinished execution, durable actor results, and producer ownership across quiescent checkpoints (recoveryEquivalent, activeOnly, localRestartOnly).
// References represent accepted requests; proposalCheckpoint.qnt models their allocation at journal acceptance.
// LocalDeferred and RemoteDeferred await PromiseSettled; Died terminates domain execution and unresolved callers.
// Reopening schedules local producers with their original reference and leaves remote producers available for observation.
// promiseDelivery.qnt models early delivery and admission retries separately.
// stored abstracts durable notebook facts; recovered holds requested and deferred work while recoveredActors holds domain progress.
// Completion updates notebook facts and domain progress atomically (platform/test/properties/runtime/operation-lifecycle.ts).
// checkpointFacts is a specification-only notebook-prefix oracle for checkpointQuiescent; serialized checkpoints contain actor results.
// Request payloads, handle validation, callback payloads, physical journal ordering, and TypeScript refinement are outside this model.
// initStranded omits durable defect recording and reproduces a blocked runtime with pending callers.
// Caller liveness assumes eventual availability and fair observation, without assuming execution succeeds.
// TLC checks the finite reachable state space and caller liveness; Apalache can check invariant induction.
// Run backend verification in a temporary directory to keep checker artifacts outside the repository.
// quint verify /absolute/path/to/effectRecovery.qnt --inductive-invariant invariant --invariants recoveryEquivalent retryIdentity deferredPreserved executionAdmission localRestartOnly checkpointQuiescent
// quint verify /absolute/path/to/effectRecovery.qnt --backend tlc --invariant invariant --temporal terminalReachesCaller
// quint verify /absolute/path/to/effectRecovery.qnt --init initStranded --backend tlc --invariant blockedIsDurable
module effectRecovery {
  type Ref = { seq: int, atom: str, act: str }
  type Status = Absent | Requested | Fulfilled | Rejected | LocalDeferred | PromiseFulfilled | PromiseRejected | RemoteDeferred | Died
  type Caller = Pending | Completed | Failed
  type Index = (Status, Status)
  type Actors = int -> Caller
  type State = {
    stored: Index, checkpoint: Actors, checkpointFacts: Index, recovered: Index, recoveredActors: Actors, recovering: bool,
    cursor: int, inFlight: int, origin: int, restartQueue: Set[int],
    callers: int -> Caller, blocked: bool, recordDefects: bool,
  }
  pure val refs = List({ seq: 0, atom: "tool", act: "call" }, { seq: 1, atom: "tool", act: "call" })
  pure val statuses = Set(Absent, Requested, Fulfilled, Rejected, LocalDeferred, PromiseFulfilled, PromiseRejected, RemoteDeferred, Died)
  pure val indexes = tuples(statuses, statuses)
  pure val slots = Set(0, 1)
  pure val empty = (Absent, Absent)
  pure val initialActors: Actors = Map(0 -> Pending, 1 -> Pending)
  pure def at(index: Index, slot: int): Status = if (slot == 0) index._1 else index._2
  pure def replaceStatus(index: Index, slot: int, status: Status): Index = if (slot == 0) (status, index._2) else (index._1, status)
  pure def terminal(status: Status): bool = status.in(Set(Fulfilled, Rejected, PromiseFulfilled, PromiseRejected, Died))
  pure def quiet(index: Index): bool = slots.forall(slot => at(index, slot) == Absent or terminal(at(index, slot)))
  pure def executable(index: Index): Set[Ref] = slots.filter(slot => at(index, slot) == Requested).map(slot => refs.nth(slot))
  pure def owned(index: Index): Set[int] = slots.filter(slot => at(index, slot) == LocalDeferred)
  pure def watched(index: Index): Set[Ref] = slots.filter(slot => at(index, slot) == RemoteDeferred).map(slot => refs.nth(slot))

  pure def hasDefect(index: Index): bool = slots.exists(slot => at(index, slot) == Died)

  pure def unfinished(status: Status): Status = if (status.in(Set(Requested, LocalDeferred, RemoteDeferred))) status else Absent
  pure def working(index: Index): Index = (unfinished(index._1), unfinished(index._2))
  pure def actorState(index: Index): Actors = slots.mapBy(slot =>
    if (at(index, slot).in(Set(Fulfilled, PromiseFulfilled))) Completed
    else if (terminal(at(index, slot)) or (hasDefect(index) and at(index, slot) != Absent)) Failed
    else Pending)

  var stored: Index
  var checkpoint: Actors
  var checkpointFacts: Index
  var recovered: Index
  var recoveredActors: Actors
  var recovering: bool
  var cursor: int
  var inFlight: int
  var origin: int
  var restartQueue: Set[int]
  var callers: int -> Caller
  var blocked: bool
  var recordDefects: bool
  val state: State = { stored: stored, checkpoint: checkpoint, checkpointFacts: checkpointFacts, recovered: recovered, recoveredActors: recoveredActors, recovering: recovering, cursor: cursor, inFlight: inFlight, origin: origin, restartQueue: restartQueue, callers: callers, blocked: blocked, recordDefects: recordDefects }
  action update(after: State): bool = all {
    stored' = after.stored, checkpoint' = after.checkpoint, checkpointFacts' = after.checkpointFacts, recovered' = after.recovered, recoveredActors' = after.recoveredActors, recovering' = after.recovering, cursor' = after.cursor, inFlight' = after.inFlight, origin' = after.origin, restartQueue' = after.restartQueue, callers' = after.callers, blocked' = after.blocked, recordDefects' = after.recordDefects
  }

  action init = all {
    stored' = empty, checkpoint' = initialActors, checkpointFacts' = empty, recovered' = empty, recoveredActors' = initialActors, recovering' = false,
    cursor' = 0, inFlight' = -1, origin' = 0, restartQueue' = Set(),
    callers' = Map(0 -> Pending, 1 -> Pending), blocked' = false, recordDefects' = true,
  }

  action initStranded = all {
    stored' = empty, checkpoint' = initialActors, checkpointFacts' = empty, recovered' = empty, recoveredActors' = initialActors, recovering' = false,
    cursor' = 0, inFlight' = -1, origin' = 0, restartQueue' = Set(),
    callers' = Map(0 -> Pending, 1 -> Pending), blocked' = false, recordDefects' = false,
  }

  action request = {
    nondet slot = slots.oneOf()
    all {
      not(state.recovering), not(state.blocked), at(state.stored, slot) == Absent,
      update(state.with("stored", replaceStatus(state.stored, slot, Requested))
        .with("recovered", replaceStatus(state.recovered, slot, Requested))
        .with("recoveredActors", actorState(replaceStatus(state.stored, slot, Requested)))),
    }
  }

  action dispatch = {
    nondet slot = slots.oneOf()
    all {
      not(state.recovering), not(state.blocked), state.inFlight == -1,
      executable(state.recovered).contains(refs.nth(slot)),
      update(state.with("inFlight", slot).with("origin", 1)),
    }
  }

  action settle = {
    nondet outcome = Set(Fulfilled, Rejected, LocalDeferred, RemoteDeferred, Died).oneOf()
    val result = if (outcome == Died and not(state.recordDefects)) Requested else outcome
    all {
      not(state.recovering), state.inFlight != -1, state.origin == 1,
      update(state.with("stored", replaceStatus(state.stored, state.inFlight, result))
        .with("recovered", working(replaceStatus(state.stored, state.inFlight, result)))
        .with("recoveredActors", actorState(replaceStatus(state.stored, state.inFlight, result)))
        .with("inFlight", -1).with("origin", 0)
        .with("blocked", state.blocked or outcome == Died)
        .with("restartQueue", if (outcome == Died) Set() else state.restartQueue)),
    }
  }

  // restart consumes a recovered local producer without appending another request or effect settlement.
  action restart = {
    nondet slot = slots.oneOf()
    all {
      not(state.recovering), not(state.blocked), state.inFlight == -1, state.restartQueue.contains(slot),
      update(state.with("inFlight", slot).with("origin", 4)
        .with("restartQueue", state.restartQueue.exclude(Set(slot)))),
    }
  }

  // finishRestart preserves a deferred result or records immediate completion as PromiseSettled; an already delivered result remains unchanged.
  action finishRestart = {
    nondet outcome = Set(LocalDeferred, PromiseFulfilled, PromiseRejected, Died).oneOf()
    val result = if (at(state.stored, state.inFlight) == LocalDeferred) (if (outcome == Died and not(state.recordDefects)) LocalDeferred else outcome) else at(state.stored, state.inFlight)
    all {
      not(state.recovering), state.inFlight != -1, state.origin == 4,
      update(state.with("stored", replaceStatus(state.stored, state.inFlight, result))
        .with("recovered", working(replaceStatus(state.stored, state.inFlight, result)))
        .with("recoveredActors", actorState(replaceStatus(state.stored, state.inFlight, result)))
        .with("inFlight", -1).with("origin", 0)
        .with("blocked", state.blocked or (outcome == Died and at(state.stored, state.inFlight) == LocalDeferred))
        .with("restartQueue", if (outcome == Died) Set() else state.restartQueue)),
    }
  }

  action resolvePromise = {
    nondet slot = slots.oneOf()
    nondet outcome = Set(PromiseFulfilled, PromiseRejected, Died).oneOf()
    val result = if (outcome == Died and not(state.recordDefects)) at(state.stored, slot) else outcome
    all {
      not(state.recovering), not(state.blocked), at(state.stored, slot).in(Set(LocalDeferred, RemoteDeferred)),
      outcome != Died or at(state.stored, slot) == LocalDeferred,
      update(state.with("stored", replaceStatus(state.stored, slot, result))
        .with("recovered", working(replaceStatus(state.stored, slot, result)))
        .with("recoveredActors", actorState(replaceStatus(state.stored, slot, result)))
        .with("blocked", outcome == Died)
        .with("inFlight", if (outcome == Died) -1 else state.inFlight)
        .with("origin", if (outcome == Died) 0 else state.origin)
        .with("restartQueue", if (outcome == Died) Set() else state.restartQueue.exclude(Set(slot)))),
    }
  }

  action capture = all {
    not(state.recovering), not(state.blocked), quiet(state.stored),
    update(state.with("checkpoint", state.recoveredActors).with("checkpointFacts", state.stored)),
  }

  action crash = update(state.with("recovered", empty).with("recoveredActors", state.checkpoint).with("recovering", true)
    .with("cursor", 0).with("inFlight", -1).with("origin", 0).with("restartQueue", Set()))

  action replayNext = all {
    state.recovering, state.cursor < 2,
    update(state.with("recovered", replaceStatus(state.recovered, state.cursor, unfinished(at(state.stored, state.cursor))))
      .with("recoveredActors", state.recoveredActors.set(state.cursor, actorState(state.stored).get(state.cursor)))
      .with("cursor", state.cursor + 1)),
  }

  action resume = all {
    state.recovering, state.cursor == 2,
    update(state.with("recovering", false).with("restartQueue", if (hasDefect(state.stored)) Set() else owned(state.recovered))
      .with("blocked", state.blocked or hasDefect(state.stored))),
  }

  action interrupt = all { not(state.recovering), state.inFlight != -1,
    update(state.with("inFlight", -1).with("origin", 0)),
  }
  // observe delivers a durable actor result without consulting a retained terminal operation.
  action observe(slot: int): bool = all {
    not(state.recovering), state.callers.get(slot) == Pending, state.recoveredActors.get(slot) != Pending,
    update(state.with("callers", state.callers.set(slot, state.recoveredActors.get(slot)))),
  }
  action idle = update(state)
  action step = any { observe(0), observe(1), interrupt, idle, request, dispatch, settle, restart, finishRestart, resolvePromise, capture, crash, replayNext, resume }

  val recoveryEquivalent = not(state.recovering) implies state.recovered == working(state.stored) and state.recoveredActors == actorState(state.stored)
  val activeOnly = slots.forall(slot => not(terminal(at(state.recovered, slot))))
  val retryIdentity = not(state.recovering) implies executable(state.recovered) == executable(state.stored)
  val deferredPreserved = not(state.recovering) implies all {
    owned(state.recovered) == owned(state.stored), watched(state.recovered) == watched(state.stored),
  }
  val executionAdmission = state.inFlight != -1 implies
    (if (state.origin == 1) at(state.stored, state.inFlight) == Requested
      else state.origin == 4 and at(state.stored, state.inFlight).in(Set(LocalDeferred, PromiseFulfilled, PromiseRejected)))
  val localRestartOnly = state.restartQueue.subseteq(owned(state.stored))
    and (state.origin == 4 implies at(state.stored, state.inFlight).in(Set(LocalDeferred, PromiseFulfilled, PromiseRejected)))
  val checkpointQuiescent = quiet(state.checkpointFacts)
  val checkpointSound = state.checkpoint == actorState(state.checkpointFacts)
  val blockedIsDurable = state.blocked implies hasDefect(state.stored)
  val terminalNotExecuted = hasDefect(state.stored) implies state.inFlight == -1
  val callerSound = slots.forall(slot => all {
    state.callers.get(slot) == Completed implies at(state.stored, slot).in(Set(Fulfilled, PromiseFulfilled)),
    state.callers.get(slot) == Failed implies at(state.stored, slot).in(Set(Rejected, PromiseRejected, Died)) or hasDefect(state.stored),
  })
  temporal terminalReachesCaller = (eventually(always(not(state.recovering))) and observe(0).weakFair(state) and observe(1).weakFair(state)) implies
    slots.forall(slot => (at(state.stored, slot) != Absent and (terminal(at(state.stored, slot)) or state.blocked)).leadsTo(state.callers.get(slot) != Pending))
  val invariant = all {
    callers.in(slots.setOfMaps(Set(Pending, Completed, Failed))), blocked.in(Set(false, true)), recordDefects == true,
    state.blocked == hasDefect(state.stored), blockedIsDurable, terminalNotExecuted, callerSound,
    hasDefect(state.stored) implies state.restartQueue == Set(),
    stored.in(indexes), checkpointFacts.in(indexes), checkpoint.in(slots.setOfMaps(Set(Pending, Completed, Failed))), recovered.in(indexes),
    recoveredActors.in(slots.setOfMaps(Set(Pending, Completed, Failed))), activeOnly, checkpointSound,
    recovering.in(Set(false, true)), cursor.in(0.to(2)), inFlight.in((-1).to(1)),
    origin.in(Set(0, 1, 4)), restartQueue.in(slots.powerset()),
    (inFlight == -1) == (origin == 0),
    inFlight != -1 implies not(restartQueue.contains(inFlight)),
    checkpointQuiescent,
    slots.forall(slot => terminal(at(checkpointFacts, slot)) implies at(checkpointFacts, slot) == at(stored, slot)),
    recoveryEquivalent, executionAdmission, localRestartOnly,
    recovering implies all {
      inFlight == -1, restartQueue == Set(),
      slots.forall(slot => at(recovered, slot) == (if (slot < cursor) unfinished(at(stored, slot)) else Absent)),
      slots.forall(slot => recoveredActors.get(slot) == (if (slot < cursor) actorState(stored).get(slot) else checkpoint.get(slot))),
    },
  }
}
