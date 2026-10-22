// localProducerHealth models recoveryState's health classification for two pending local promises (runningMeansCovered).
// Both promises have recorded finite deadlines; inline work, cleanup, deliveries, and cancellation are absent.
// Producer loss leaves a promise pending without a terminal result; its TypeScript reachability is an implementation obligation.
// Recovery queues, handle admission, and recorded retry waits account for intentionally unavailable producers.
// This finite safety model does not establish recovery latency, eventual completion, or TypeScript refinement.
module localProducerHealth {
  type State = {
    pending: Set[int], live: Set[int], recovering: Set[int], admitting: Set[int], retrying: Set[int],
    online: bool, guardOrphans: bool,
  }
  pure val refs = Set(0, 1)
  pure def initial(guard: bool): State = {
    pending: refs, live: refs, recovering: Set(), admitting: Set(), retrying: Set(),
    online: true, guardOrphans: guard,
  }
  var state: State
  action init = state' = initial(false)
  action initWithOrphanGuard = state' = initial(true)

  val accounted = state.live.union(state.recovering).union(state.admitting).union(state.retrying)
  val orphaned = state.pending.exclude(accounted)
  // reported models the live.length shortcut; pending includes a retryable probe failure under the orphan guard.
  val reported =
    if (not(state.online)) "unavailable"
    else if (state.pending == Set()) "settled"
    else if (state.pending.subseteq(state.retrying)) "parked"
    else if (state.guardOrphans and orphaned != Set()) "pending"
    else if (state.live != Set()) "running"
    else "pending"

  action loseProducer(ref: int): bool = all {
    state.online, state.live.contains(ref),
    state' = state.with("live", state.live.exclude(Set(ref))),
  }
  action complete(ref: int): bool = all {
    state.online, state.live.contains(ref),
    state' = state.with("pending", state.pending.exclude(Set(ref))).with("live", state.live.exclude(Set(ref))),
  }
  action crash = all {
    state.online,
    state' = state.with("online", false).with("live", Set()).with("recovering", Set()).with("admitting", Set()),
  }
  action reopen = all {
    not(state.online),
    state' = state.with("online", true).with("recovering", state.pending.exclude(state.retrying)),
  }
  action queueRecovery(ref: int): bool = all {
    state.online, orphaned.contains(ref),
    state' = state.with("recovering", state.recovering.union(Set(ref))),
  }
  action beginRecovery(ref: int): bool = all {
    state.online, state.recovering.contains(ref),
    state' = state.with("recovering", state.recovering.exclude(Set(ref))).with("admitting", state.admitting.union(Set(ref))),
  }
  action registerProducer(ref: int): bool = all {
    state.online, state.admitting.contains(ref),
    state' = state.with("admitting", state.admitting.exclude(Set(ref))).with("live", state.live.union(Set(ref))),
  }
  action queueRetry(ref: int): bool = all {
    state.online, orphaned.contains(ref),
    state' = state.with("retrying", state.retrying.union(Set(ref))),
  }
  action retryDue(ref: int): bool = all {
    state.online, state.retrying.contains(ref),
    state' = state.with("retrying", state.retrying.exclude(Set(ref))).with("recovering", state.recovering.union(Set(ref))),
  }
  action idle = state' = state
  action step = {
    nondet ref = refs.oneOf()
    any { loseProducer(ref), complete(ref), crash, reopen, queueRecovery(ref), beginRecovery(ref), registerProducer(ref), queueRetry(ref), retryDue(ref), idle }
  }

  val typeInvariant = all {
    state.pending.subseteq(refs), accounted.subseteq(state.pending),
    state.live.intersect(state.recovering.union(state.admitting).union(state.retrying)) == Set(),
    state.recovering.intersect(state.admitting.union(state.retrying)) == Set(),
    state.admitting.intersect(state.retrying) == Set(),
    not(state.online) implies state.live.union(state.recovering).union(state.admitting) == Set(),
  }
  val runningMeansCovered = reported == "running" implies orphaned == Set()
  val invariant = typeInvariant and runningMeansCovered

  run siblingMasksOrphanTest = init.then(loseProducer(0))
    .expect(state.pending == refs and state.live == Set(1) and reported == "running" and not(runningMeansCovered))
  run coldSiblingMasksOrphanTest = init.then(crash).then(reopen)
    .then(beginRecovery(0)).then(registerProducer(0)).then(beginRecovery(1)).then(registerProducer(1))
    .then(loseProducer(0)).expect(reported == "running" and not(runningMeansCovered))
  run orphanGuardTest = initWithOrphanGuard.then(loseProducer(0)).expect(reported == "pending" and invariant)
    .then(queueRecovery(0)).then(beginRecovery(0)).then(registerProducer(0)).expect(reported == "running" and invariant)
  run survivingSiblingFinishesTest = initWithOrphanGuard.then(loseProducer(0)).then(complete(1))
    .expect(state.pending == Set(0) and reported == "pending" and invariant)
  run recoveryAndAdmissionTest = initWithOrphanGuard.then(crash).then(reopen)
    .then(beginRecovery(0)).then(registerProducer(0)).expect(reported == "running" and invariant)
    .then(beginRecovery(1)).expect(reported == "running" and invariant)
    .then(registerProducer(1)).expect(reported == "running" and invariant)
  run deliberateRetryTest = initWithOrphanGuard.then(loseProducer(0)).then(queueRetry(0))
    .expect(reported == "running" and invariant).then(complete(1)).expect(reported == "parked" and invariant)
    .then(retryDue(0)).then(beginRecovery(0)).then(registerProducer(0)).expect(reported == "running" and invariant)
  run noLiveSiblingTest = init.then(loseProducer(0)).then(loseProducer(1)).expect(reported == "pending" and invariant)
}
