// invocationReplay models a local parent fibre awaiting a durable child invocation (oneLogicalExecution, eventualOutcome).
// Child acceptance and result storage are atomic abstractions; event transport and parent recovery are weakly fair.
// The finite instance has two possible invocation IDs and a saturating duplicate-execution counter.
module invocationReplay {
  type State = {
    parent: str, fibre: str, online: bool, crashed: bool, started: bool,
    key: int, generation: bool, accepted: Set[int], completed: Set[int], delivered: Set[int], inbox: Set[int],
    executions: int, subscribed: bool, noticed: bool,
    stableIdentity: bool, deduplicate: bool, durableReply: bool, readOnSubscribe: bool,
    replaySafe: bool, respectReplayPolicy: bool,
    durableDependency: bool, dependencyAlive: bool,
  }
  pure val ids = Set(0, 1)
  pure val initial: State = {
    parent: "pending", fibre: "absent", online: true, crashed: false, started: false,
    key: 0, generation: false, accepted: Set(), completed: Set(), delivered: Set(), inbox: Set(),
    executions: 0, subscribed: false, noticed: false,
    stableIdentity: true, deduplicate: true, durableReply: true, readOnSubscribe: true,
    replaySafe: true, respectReplayPolicy: true,
    durableDependency: true, dependencyAlive: true,
  }
  var state: State
  action init = state' = initial
  action initFreshIdentity = state' = initial.with("stableIdentity", false)
  action initWithoutDeduplication = state' = initial.with("deduplicate", false)
  action initVolatileReply = state' = initial.with("durableReply", false)
  action initBlindSubscribe = state' = initial.with("readOnSubscribe", false)
  action initUnsafe = state' = initial.with("replaySafe", false).with("deduplicate", false)
  action initReplayUnsafe = state' = initial.with("replaySafe", false).with("deduplicate", false).with("respectReplayPolicy", false)
  action initVolatileDependency = state' = initial.with("durableDependency", false)

  // start reconstructs the parent operation with its recorded identity or rejects unsupported replay.
  action start = all {
    state.online, state.parent == "pending", state.fibre == "absent",
    if (state.started and not(state.replaySafe) and state.respectReplayPolicy)
      state' = state.with("parent", "interrupted")
    else state' = state.with("fibre", "submitting")
      .with("key", if (state.stableIdentity or not(state.generation)) 0 else 1)
      .with("generation", not(state.generation)).with("started", true),
  }
  action submit = {
    val duplicate = state.accepted.contains(state.key)
    all {
      state.online, state.fibre == "submitting",
      state' = state.with("accepted", state.accepted.union(Set(state.key))).with("fibre", "waiting")
        .with("executions", if ((not(duplicate) or not(state.deduplicate)) and state.executions < 2) state.executions + 1 else state.executions),
    }
  }
  action completeChild(id: int): bool = all {
    id.in(ids), state.accepted.contains(id), not(state.completed.contains(id)), state.durableDependency or state.dependencyAlive,
    state' = state.with("completed", state.completed.union(Set(id))),
  }
  // deliver acknowledges a result after durable inbox acceptance, independently of the current waiter.
  action deliver(id: int): bool = all {
    id.in(ids), state.online, state.completed.contains(id), not(state.delivered.contains(id)),
    state' = state.with("inbox", if (state.durableReply) state.inbox.union(Set(id)) else state.inbox)
      .with("delivered", state.delivered.union(Set(id)))
      .with("noticed", state.noticed or (state.online and state.fibre == "waiting" and state.subscribed and state.key == id)),
  }
  action subscribe = all {
    state.online, state.fibre == "waiting", not(state.subscribed),
    state' = state.with("subscribed", true)
      .with("noticed", state.noticed or (state.readOnSubscribe and state.inbox.contains(state.key))),
  }
  action consume = all {
    state.online, state.fibre == "waiting", state.noticed,
    state' = state.with("parent", "completed").with("fibre", "absent").with("subscribed", false).with("noticed", false),
  }
  action crash = state' = state.with("online", false).with("crashed", true)
    .with("fibre", "absent").with("subscribed", false).with("noticed", false)
    .with("dependencyAlive", if (state.durableDependency) state.dependencyAlive else false)
  action reopen = all { not(state.online), state' = state.with("online", true).with("crashed", false) }
  action idle = state' = state.with("crashed", false)
  action completeAny = { nondet id = ids.oneOf(); completeChild(id) }
  action deliverAny = { nondet id = ids.oneOf(); deliver(id) }
  action step = any { start, submit, completeAny, deliverAny, subscribe, consume, crash, reopen, idle }

  val typeOK = all {
    state.parent.in(Set("pending", "completed", "interrupted")), state.fibre.in(Set("absent", "submitting", "waiting")),
    state.key.in(ids), state.executions.in(0.to(2)), state.accepted.subseteq(ids),
    state.completed.subseteq(state.accepted), state.delivered.subseteq(state.completed), state.inbox.subseteq(state.completed),
    not(state.online) implies state.fibre == "absent" and not(state.subscribed) and not(state.noticed),
  }
  val oneLogicalExecution = state.executions <= 1
  val replayIdentity = state.replaySafe implies state.key == 0
  val resultSound = state.parent == "completed" implies state.completed.contains(state.key)
  val replyDurability = state.delivered.subseteq(state.inbox)
  val dependencyRecoverable = state.parent == "pending" and state.accepted != state.completed
    implies state.durableDependency or state.dependencyAlive
  val invariant = all { typeOK, oneLogicalExecution, replayIdentity, resultSound, replyDurability, dependencyRecoverable }
  temporal fairService = start.weakFair(state) and submit.weakFair(state)
    and completeChild(0).weakFair(state) and completeChild(1).weakFair(state)
    and deliver(0).weakFair(state) and deliver(1).weakFair(state)
    and subscribe.weakFair(state) and consume.weakFair(state) and reopen.weakFair(state)
  temporal eventualQuiet = eventually(always(state.online and not(state.crashed)))
  temporal eventualOutcome = (fairService and eventualQuiet) implies
    (state.parent == "pending").leadsTo(state.parent != "pending")

  run stableReplayTest = init.then(start).then(submit).then(completeChild(0)).then(deliver(0))
    .then(crash).then(reopen).then(start).then(submit).then(subscribe).then(consume)
    .expect(state.parent == "completed" and state.executions == 1 and invariant)
  run freshIdentityTest = initFreshIdentity.then(start).then(submit).then(crash).then(reopen).then(start).then(submit)
    .expect(not(oneLogicalExecution) and not(replayIdentity))
  run missingDeduplicationTest = initWithoutDeduplication.then(start).then(submit).then(crash).then(reopen).then(start).then(submit)
    .expect(not(oneLogicalExecution))
  run unsafeReplayTest = initUnsafe.then(start).then(submit).then(crash).then(reopen).then(start)
    .expect(state.parent == "interrupted" and state.executions == 1 and invariant)
  run forcedUnsafeReplayTest = initReplayUnsafe.then(start).then(submit).then(crash).then(reopen).then(start).then(submit)
    .expect(not(oneLogicalExecution))
  run subscribeAfterResultTest = init.then(start).then(submit).then(completeChild(0)).then(deliver(0))
    .then(subscribe).then(consume).expect(state.parent == "completed")
  run resultAfterSubscribeTest = init.then(start).then(submit).then(subscribe).then(completeChild(0)).then(deliver(0))
    .then(consume).expect(state.parent == "completed")
  run blindSubscribeTest = initBlindSubscribe.then(start).then(submit).then(completeChild(0)).then(deliver(0))
    .then(subscribe).expect(state.parent == "pending" and state.inbox.contains(0) and state.delivered.contains(0) and not(state.noticed))
  run lostReplyTest = initVolatileReply.then(start).then(submit).then(subscribe).then(completeChild(0)).then(deliver(0))
    .then(crash).then(reopen).then(start).then(submit).then(subscribe)
    .expect(state.parent == "pending" and state.delivered.contains(0) and not(state.inbox.contains(0)) and not(state.noticed))
  run lostDependencyTest = initVolatileDependency.then(start).then(submit).then(crash).then(reopen).then(start).then(submit)
    .then(subscribe).expect(state.parent == "pending" and not(dependencyRecoverable) and state.executions == 1)
}
