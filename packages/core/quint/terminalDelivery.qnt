// terminalDelivery models terminal callbacks and independently owned results in an acknowledged batch.
// Both references begin as accepted deferred work; reference 0 blocks an actor turn, and reference 1 is unrelated work.
// Cancellation delivers rejected(Cancelled) through the regular terminal callback in the same commit.
// receiveBatch suppresses late result groups while preserving unrelated groups and their correlated follow-ups.
// Domain decisions, queued input, and accepted results survive reopening; availability is volatile.
// This model checks the integration contract; it does not prove TypeScript correspondence or remote abort acknowledgement.
// initStrandedDomain and initDroppedBatch reproduce missing terminal callbacks and whole-batch suppression.
// Run backend verification from a temporary directory to keep generated artifacts outside the repository.
// quint verify /absolute/path/to/terminalDelivery.qnt --inductive-invariant invariant --invariants terminalExclusive deliverySound validBatchPreserved callbackAtMostOnce
// quint verify /absolute/path/to/terminalDelivery.qnt --backend tlc --temporal nextTurnProgress
// quint verify /absolute/path/to/terminalDelivery.qnt --init initDroppedBatch --invariant validBatchPreserved
// quint verify /absolute/path/to/terminalDelivery.qnt --init initStrandedDomain --backend tlc --temporal nextTurnProgress
module terminalDelivery {
  pure val refs = Set(0, 1)
  type State = {
    cancelled: Set[int], completed: Set[int], delivered: Set[int], expected: Set[int],
    active: Set[int], callbacks: int -> int, queued: bool, advanced: bool,
    online: bool, settleCancellation: bool, dropWholeBatch: bool,
  }
  var cancelled: Set[int]
  var completed: Set[int]
  var delivered: Set[int]
  var expected: Set[int]
  var active: Set[int]
  var callbacks: int -> int
  var queued: bool
  var advanced: bool
  var online: bool
  var settleCancellation: bool
  var dropWholeBatch: bool
  val state: State = { cancelled: cancelled, completed: completed, delivered: delivered, expected: expected, active: active, callbacks: callbacks, queued: queued, advanced: advanced, online: online, settleCancellation: settleCancellation, dropWholeBatch: dropWholeBatch }
  action update(after: State): bool = all {
    cancelled' = after.cancelled, completed' = after.completed, delivered' = after.delivered,
    expected' = after.expected, active' = after.active, callbacks' = after.callbacks,
    queued' = after.queued, advanced' = after.advanced, online' = after.online,
    settleCancellation' = after.settleCancellation, dropWholeBatch' = after.dropWholeBatch,
  }
  action init = all {
    cancelled' = Set(), completed' = Set(), delivered' = Set(), expected' = Set(),
    active' = refs, callbacks' = Map(0 -> 0, 1 -> 0), queued' = false, advanced' = false,
    online' = true, settleCancellation' = true, dropWholeBatch' = false,
  }
  action initStrandedDomain = all {
    cancelled' = Set(), completed' = Set(), delivered' = Set(), expected' = Set(),
    active' = refs, callbacks' = Map(0 -> 0, 1 -> 0), queued' = false, advanced' = false,
    online' = true, settleCancellation' = false, dropWholeBatch' = false,
  }
  action initDroppedBatch = all {
    cancelled' = Set(), completed' = Set(), delivered' = Set(), expected' = Set(),
    active' = refs, callbacks' = Map(0 -> 0, 1 -> 0), queued' = false, advanced' = false,
    online' = true, settleCancellation' = true, dropWholeBatch' = true,
  }

  // cancel commits the terminal decision and its callback; duplicate or completion-first cancellation is a no-op.
  action cancel(ref: int): bool = {
    val fresh = if (state.completed.contains(ref) or state.cancelled.contains(ref)) Set() else Set(ref)
    val terminal = if (state.settleCancellation) fresh else Set()
    all {
      state.online, ref.in(refs),
      update(state.with("cancelled", state.cancelled.union(fresh))
        .with("delivered", state.delivered.union(terminal))
        .with("active", state.active.exclude(terminal))
        .with("callbacks", terminal.fold(state.callbacks, (counts, id) => counts.set(id, counts.get(id) + 1)))),
    }
  }

  // receiveBatch acknowledges independently owned groups; each fresh terminal outcome delivers its callback once.
  action receiveBatch(batch: Set[int]): bool = {
    val valid = batch.exclude(state.cancelled)
    val accepted = if (state.dropWholeBatch and batch.intersect(state.cancelled) != Set()) Set() else valid
    val fresh = accepted.exclude(state.completed)
    all {
      state.online, batch.in(refs.powerset()), batch != Set(),
      update(state.with("completed", state.completed.union(accepted))
        .with("delivered", state.delivered.union(accepted))
        .with("expected", state.expected.union(valid))
        .with("active", state.active.exclude(accepted))
        .with("callbacks", fresh.fold(state.callbacks, (counts, id) => counts.set(id, counts.get(id) + 1)))),
    }
  }
  action message = all {
    state.online, not(state.queued), not(state.advanced), update(state.with("queued", true)),
  }
  action advance = all {
    state.online, state.queued, not(state.active.contains(0)),
    update(state.with("queued", false).with("advanced", true)),
  }
  action crash = all { state.online, update(state.with("online", false)) }
  action reopen = all { not(state.online), update(state.with("online", true)) }
  action step = {
    nondet ref = refs.oneOf()
    nondet batch = refs.powerset().exclude(Set(Set())).oneOf()
    any { cancel(ref), receiveBatch(batch), message, advance, crash, reopen, update(state) }
  }

  val terminalExclusive = state.cancelled.intersect(state.completed) == Set()
  val deliverySound = state.delivered == state.completed.union(state.cancelled)
  val validBatchPreserved = state.expected.subseteq(state.completed)
  val callbackAtMostOnce = refs.forall(ref => state.callbacks.get(ref) <= 1)
  val domainSound = state.active == refs.exclude(state.delivered) and refs.forall(ref =>
    state.callbacks.get(ref) == (if (state.delivered.contains(ref)) 1 else 0))
  val invariant = all {
    cancelled.in(refs.powerset()), completed.in(refs.powerset()), delivered.in(refs.powerset()),
    expected.in(refs.powerset()), active.in(refs.powerset()), callbacks.in(refs.setOfMaps(0.to(1))),
    queued.in(Set(false, true)), advanced.in(Set(false, true)), online.in(Set(false, true)),
    settleCancellation == true, dropWholeBatch == false, state.completed == state.expected,
    not(state.advanced and state.queued), state.advanced implies not(state.active.contains(0)),
    terminalExclusive, deliverySound, validBatchPreserved, callbackAtMostOnce, domainSound,
  }
  temporal nextTurnProgress = (eventually(always(state.online)) and advance.weakFair(state)) implies
    (state.queued and state.cancelled.contains(0)).leadsTo(state.advanced)
}
