// effectRecovery models lifecycle preservation and producer ownership across quiescent checkpoints (recoveryEquivalent, localRestartOnly).
// References represent accepted requests; proposalCheckpoint.qnt models their allocation at journal acceptance.
// Status 4 represents local deferred work and status 7 represents remote deferred work; both await PromiseSettled.
// Reopening schedules local producers with their original reference and leaves remote producers available for observation.
// promiseDelivery.qnt models early delivery and admission retries separately.
// Request payloads, handle validation, callbacks, physical journal ordering, and TypeScript refinement are outside this model.
// Quint 0.32.0 with Apalache 0.56.1 checks invariant initialization, preservation, and implication of the listed safety properties.
// Run backend verification in a temporary directory to keep checker artifacts outside the repository.
// quint verify /absolute/path/to/effectRecovery.qnt --inductive-invariant invariant --invariants recoveryEquivalent retryIdentity deferredPreserved executionAdmission localRestartOnly checkpointQuiescent
module effectRecovery {
  type Ref = { seq: int, atom: str, act: str }
  type Index = (int, int)
  type State = {
    stored: Index, checkpoint: Index, recovered: Index, recovering: bool,
    cursor: int, inFlight: int, origin: int, restartQueue: Set[int],
  }
  pure val refs = List({ seq: 0, atom: "tool", act: "call" }, { seq: 1, atom: "tool", act: "call" })
  // statuses encodes absent, requested, immediate fulfillment, rejection, local deferred, promise fulfillment, promise rejection, and remote deferred.
  pure val statuses = 0.to(7)
  pure val indexes = tuples(statuses, statuses)
  pure val slots = Set(0, 1)
  pure val empty = (0, 0)
  pure def at(index: Index, slot: int): int = if (slot == 0) index._1 else index._2
  pure def replaceStatus(index: Index, slot: int, status: int): Index = if (slot == 0) (status, index._2) else (index._1, status)
  pure def terminal(status: int): bool = status.in(Set(2, 3, 5, 6))
  pure def quiet(index: Index): bool = slots.forall(slot => at(index, slot) == 0 or terminal(at(index, slot)))
  pure def executable(index: Index): Set[Ref] = slots.filter(slot => at(index, slot) == 1).map(slot => refs.nth(slot))
  pure def owned(index: Index): Set[int] = slots.filter(slot => at(index, slot) == 4)
  pure def watched(index: Index): Set[Ref] = slots.filter(slot => at(index, slot) == 7).map(slot => refs.nth(slot))

  var stored: Index
  var checkpoint: Index
  var recovered: Index
  var recovering: bool
  var cursor: int
  var inFlight: int
  var origin: int
  var restartQueue: Set[int]
  val state: State = { stored: stored, checkpoint: checkpoint, recovered: recovered, recovering: recovering, cursor: cursor, inFlight: inFlight, origin: origin, restartQueue: restartQueue }
  action update(after: State): bool = all {
    stored' = after.stored, checkpoint' = after.checkpoint, recovered' = after.recovered, recovering' = after.recovering, cursor' = after.cursor, inFlight' = after.inFlight, origin' = after.origin, restartQueue' = after.restartQueue
  }

  action init = update({
    stored: empty, checkpoint: empty, recovered: empty, recovering: false,
    cursor: 0, inFlight: -1, origin: 0, restartQueue: Set(),
  })

  action request = {
    nondet slot = slots.oneOf()
    all {
      not(state.recovering), at(state.stored, slot) == 0,
      update(state.with("stored", replaceStatus(state.stored, slot, 1))
        .with("recovered", replaceStatus(state.recovered, slot, 1))),
    }
  }

  action dispatch = {
    nondet slot = slots.oneOf()
    all {
      not(state.recovering), state.inFlight == -1,
      executable(state.recovered).contains(refs.nth(slot)),
      update(state.with("inFlight", slot).with("origin", 1)),
    }
  }

  action settle = {
    nondet outcome = Set(2, 3, 4, 7).oneOf()
    all {
      not(state.recovering), state.inFlight != -1, state.origin == 1,
      update(state.with("stored", replaceStatus(state.stored, state.inFlight, outcome))
        .with("recovered", replaceStatus(state.recovered, state.inFlight, outcome))
        .with("inFlight", -1).with("origin", 0)),
    }
  }

  // restart consumes a recovered local producer without appending another request or effect settlement.
  action restart = {
    nondet slot = slots.oneOf()
    all {
      not(state.recovering), state.inFlight == -1, state.restartQueue.contains(slot),
      update(state.with("inFlight", slot).with("origin", 4)
        .with("restartQueue", state.restartQueue.exclude(Set(slot)))),
    }
  }

  // finishRestart preserves a deferred result or records immediate completion as PromiseSettled; an already delivered result remains unchanged.
  action finishRestart = {
    nondet outcome = Set(4, 5, 6).oneOf()
    val result = if (at(state.stored, state.inFlight) == 4) outcome else at(state.stored, state.inFlight)
    all {
      not(state.recovering), state.inFlight != -1, state.origin == 4,
      update(state.with("stored", replaceStatus(state.stored, state.inFlight, result))
        .with("recovered", replaceStatus(state.recovered, state.inFlight, result))
        .with("inFlight", -1).with("origin", 0)),
    }
  }

  action resolvePromise = {
    nondet slot = slots.oneOf()
    nondet outcome = Set(5, 6).oneOf()
    all {
      not(state.recovering), at(state.stored, slot).in(Set(4, 7)),
      update(state.with("stored", replaceStatus(state.stored, slot, outcome))
        .with("recovered", replaceStatus(state.recovered, slot, outcome))
        .with("restartQueue", state.restartQueue.exclude(Set(slot)))),
    }
  }

  action capture = all {
    not(state.recovering), quiet(state.stored),
    update(state.with("checkpoint", state.stored)),
  }

  action crash = update(state.with("recovered", state.checkpoint).with("recovering", true)
    .with("cursor", 0).with("inFlight", -1).with("origin", 0).with("restartQueue", Set()))

  action replayNext = all {
    state.recovering, state.cursor < 2,
    update(state.with("recovered", replaceStatus(state.recovered, state.cursor, at(state.stored, state.cursor)))
      .with("cursor", state.cursor + 1)),
  }

  action resume = all {
    state.recovering, state.cursor == 2,
    update(state.with("recovering", false).with("restartQueue", owned(state.recovered))),
  }

  action step = any { request, dispatch, settle, restart, finishRestart, resolvePromise, capture, crash, replayNext, resume }

  val recoveryEquivalent = not(state.recovering) implies state.recovered == state.stored
  val retryIdentity = not(state.recovering) implies executable(state.recovered) == executable(state.stored)
  val deferredPreserved = not(state.recovering) implies all {
    owned(state.recovered) == owned(state.stored), watched(state.recovered) == watched(state.stored),
  }
  val executionAdmission = state.inFlight != -1 implies
    (if (state.origin == 1) at(state.stored, state.inFlight) == 1
      else state.origin == 4 and at(state.stored, state.inFlight).in(Set(4, 5, 6)))
  val localRestartOnly = state.restartQueue.subseteq(owned(state.stored))
    and (state.origin == 4 implies at(state.stored, state.inFlight).in(Set(4, 5, 6)))
  val checkpointQuiescent = quiet(state.checkpoint)
  val invariant = all {
    stored.in(indexes), checkpoint.in(indexes), recovered.in(indexes),
    recovering.in(Set(false, true)), cursor.in(0.to(2)), inFlight.in((-1).to(1)),
    origin.in(Set(0, 1, 4)), restartQueue.in(slots.powerset()),
    (inFlight == -1) == (origin == 0),
    inFlight != -1 implies not(restartQueue.contains(inFlight)),
    checkpointQuiescent,
    slots.forall(slot => terminal(at(checkpoint, slot)) implies at(checkpoint, slot) == at(stored, slot)),
    recoveryEquivalent, executionAdmission, localRestartOnly,
    recovering implies all {
      inFlight == -1, restartQueue == Set(),
      slots.forall(slot => at(recovered, slot) == (if (slot < cursor) at(stored, slot) else at(checkpoint, slot))),
    },
  }
}
