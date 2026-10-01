// actorCancellation models an actor interface, composed proposal sources, and durable turn cancellation.
// compose extends a DAG; project overapproximates pure graph evaluation with arbitrary proposals from its nodes.
// Runtime acceptance checks current actor state and proposals, including when discovery preceded a stop commit.
// Accepted effects, terminal callbacks, tool obligations, and the stop fence survive crashes; discovered proposals do not.
// Terminal callbacks can introduce tools while decreasing pending effects; drainingRank orders these counts lexicographically.
// The finite instance has three effect references and tool obligations, one turn, and a queued next-turn marker.
// Ownership assigns accepted work to this turn; remote abort acknowledgement, cross-log ownership, arbitrary callbacks, and TypeScript refinement are outside this model.
// agentTurnCancellation in platform/test/properties/agent-cancellation.ts checks the implementation's corresponding scenarios.
// initUnfenced admits stale proposals after stopping; initUndrained settles with outstanding tools.
// Run backend verification from a temporary directory to keep generated artifacts outside the repository.
// quint verify /absolute/path/to/actorCancellation.qnt --inductive-invariant invariant --invariants acceptanceFenced terminalExclusive callbackAtMostOnce settlementSound drainingRank
// acceptanceFenced makes projection and composition stutter on draining state after stopping; initStopped overapproximates every pending-work and tool-obligation subset.
// quint verify /absolute/path/to/actorCancellation.qnt --backend tlc --init initStopped --step stepStopped --invariant invariant --temporal cancellationProgress,nextTurnProgress
module actorCancellation {
  type Link = (int, int)
  type State = {
    nodes: Set[int], dependencies: Set[Link], proposals: Set[int], discovered: Set[int],
    accepted: Set[int], completed: Set[int], cancelled: Set[int], callbacks: int -> int,
    tools: Set[int], phase: str, stopRecorded: bool, stopAccepted: Set[int], settlements: int,
    queued: bool, advanced: bool, online: bool, fenced: bool, drainRequired: bool, previousRank: (int, int, int), previousStopping: int,
  }
  pure val refs = Set(0, 1, 2)
  pure val links = Set((0, 1), (0, 2), (1, 2))
  var nodes: Set[int]
  var dependencies: Set[Link]
  var proposals: Set[int]
  var discovered: Set[int]
  var accepted: Set[int]
  var completed: Set[int]
  var cancelled: Set[int]
  var callbacks: int -> int
  var tools: Set[int]
  var phase: str
  var stopRecorded: bool
  var stopAccepted: Set[int]
  var settlements: int
  var queued: bool
  var advanced: bool
  var online: bool
  var fenced: bool
  var drainRequired: bool
  var previousRank: (int, int, int)
  var previousStopping: int
  val state: State = { nodes: nodes, dependencies: dependencies, proposals: proposals, discovered: discovered, accepted: accepted, completed: completed, cancelled: cancelled, callbacks: callbacks, tools: tools, phase: phase, stopRecorded: stopRecorded, stopAccepted: stopAccepted, settlements: settlements, queued: queued, advanced: advanced, online: online, fenced: fenced, drainRequired: drainRequired, previousRank: previousRank, previousStopping: previousStopping }

  pure def initial(fenced: bool, drainRequired: bool): State = {
    nodes: Set(0), dependencies: Set(), proposals: Set(), discovered: Set(),
    accepted: Set(), completed: Set(), cancelled: Set(), callbacks: Map(0 -> 0, 1 -> 0, 2 -> 0),
    tools: Set(), phase: "idle", stopRecorded: false, stopAccepted: Set(), settlements: 0,
    queued: false, advanced: false, online: true, fenced: fenced, drainRequired: drainRequired, previousRank: (0, 0, 1), previousStopping: 0,
  }
  action init = {
    val start = initial(true, true)
    all {
      nodes' = start.nodes, dependencies' = start.dependencies, proposals' = start.proposals, discovered' = start.discovered, accepted' = start.accepted, completed' = start.completed, cancelled' = start.cancelled, callbacks' = start.callbacks, tools' = start.tools, phase' = start.phase, stopRecorded' = start.stopRecorded, stopAccepted' = start.stopAccepted, settlements' = start.settlements, queued' = start.queued, advanced' = start.advanced, online' = start.online, fenced' = start.fenced, drainRequired' = start.drainRequired, previousRank' = start.previousRank, previousStopping' = start.previousStopping
    }
  }
  action initUnfenced = {
    val start = initial(false, true)
    all {
      nodes' = start.nodes, dependencies' = start.dependencies, proposals' = start.proposals, discovered' = start.discovered, accepted' = start.accepted, completed' = start.completed, cancelled' = start.cancelled, callbacks' = start.callbacks, tools' = start.tools, phase' = start.phase, stopRecorded' = start.stopRecorded, stopAccepted' = start.stopAccepted, settlements' = start.settlements, queued' = start.queued, advanced' = start.advanced, online' = start.online, fenced' = start.fenced, drainRequired' = start.drainRequired, previousRank' = start.previousRank, previousStopping' = start.previousStopping
    }
  }
  action initUndrained = {
    val start = initial(true, false)
    all {
      nodes' = start.nodes, dependencies' = start.dependencies, proposals' = start.proposals, discovered' = start.discovered, accepted' = start.accepted, completed' = start.completed, cancelled' = start.cancelled, callbacks' = start.callbacks, tools' = start.tools, phase' = start.phase, stopRecorded' = start.stopRecorded, stopAccepted' = start.stopAccepted, settlements' = start.settlements, queued' = start.queued, advanced' = start.advanced, online' = start.online, fenced' = start.fenced, drainRequired' = start.drainRequired, previousRank' = start.previousRank, previousStopping' = start.previousStopping
    }
  }
  // initStopped represents the draining state of a stopped actor with arbitrary remaining obligations.
  action initStopped = {
    nondet work = refs.powerset().oneOf()
    nondet queuedTools = refs.powerset().oneOf()
    nondet edges = links.powerset().oneOf()
    val start = initial(true, true).with("nodes", refs).with("dependencies", edges)
      .with("accepted", work).with("stopAccepted", work).with("tools", queuedTools)
      .with("phase", "stopping").with("stopRecorded", true)
    all {
      nodes' = start.nodes, dependencies' = start.dependencies, proposals' = start.proposals, discovered' = start.discovered, accepted' = start.accepted, completed' = start.completed, cancelled' = start.cancelled, callbacks' = start.callbacks, tools' = start.tools, phase' = start.phase, stopRecorded' = start.stopRecorded, stopAccepted' = start.stopAccepted, settlements' = start.settlements, queued' = start.queued, advanced' = start.advanced, online' = start.online, fenced' = start.fenced, drainRequired' = start.drainRequired, previousRank' = start.previousRank, previousStopping' = start.previousStopping
    }
  }


  pure def terminal(s: State): Set[int] = s.completed.union(s.cancelled)
  pure def pending(s: State): Set[int] = s.accepted.exclude(terminal(s))
  pure def rank(s: State): (int, int, int) = (pending(s).size(), s.tools.size(), if (s.phase == "cancelled") 0 else 1)
  pure def greater(left: (int, int, int), right: (int, int, int)): bool =
    left._1 > right._1 or (left._1 == right._1 and (left._2 > right._2 or (left._2 == right._2 and left._3 > right._3)))
  action update(after: State): bool = all {
    nodes' = after.nodes, dependencies' = after.dependencies, proposals' = after.proposals, discovered' = after.discovered, accepted' = after.accepted, completed' = after.completed, cancelled' = after.cancelled, callbacks' = after.callbacks, tools' = after.tools, phase' = after.phase, stopRecorded' = after.stopRecorded, stopAccepted' = after.stopAccepted, settlements' = after.settlements, queued' = after.queued, advanced' = after.advanced, online' = after.online, fenced' = after.fenced, drainRequired' = after.drainRequired,
    previousRank' = rank(state), previousStopping' = if (state.phase == "stopping") 1 else 0,
  }

  // compose adds a source with dependencies restricted to existing earlier nodes.
  action compose(ref: int, parents: Set[int]): bool = all {
    state.online, ref.in(refs), not(state.nodes.contains(ref)), parents.subseteq(state.nodes), parents.forall(parent => parent < ref),
    update(state.with("nodes", state.nodes.union(Set(ref)))
      .with("dependencies", state.dependencies.union(parents.map(parent => (parent, ref))))),
  }
  action project(output: Set[int]): bool = all {
    state.online, output.subseteq(state.nodes), update(state.with("proposals", output)),
  }
  action discover = all {
    state.online, update(state.with("discovered", state.proposals)),
  }
  action message = all { state.online, state.phase == "idle", update(state.with("phase", "active")) }

  // accept allocates work at the commit boundary and rejects discoveries invalidated by the actor gate.
  action accept(ref: int): bool = all {
    state.online, state.discovered.contains(ref), not(state.accepted.contains(ref)),
    not(state.fenced) or (state.phase == "active" and state.proposals.contains(ref)),
    update(state.with("accepted", state.accepted.union(Set(ref)))),
  }
  // stop preserves the first stop decision; idle and terminal actors ignore it.
  action stop = all {
    state.online,
    update(if (state.phase == "active") state.with("phase", "stopping")
      .with("stopRecorded", true).with("stopAccepted", state.accepted) else state),
  }

  // finish commits a fresh terminal outcome and its callback, which may introduce tool obligations.
  action finish(ref: int, tools: Set[int]): bool = all {
    state.online, pending(state).contains(ref), tools.subseteq(state.nodes),
    state.phase.in(Set("active", "stopping")) or tools == Set(),
    update(state.with("completed", state.completed.union(Set(ref)))
      .with("callbacks", state.callbacks.set(ref, state.callbacks.get(ref) + 1))
      .with("tools", state.tools.union(tools))),
  }
  // cancel commits a terminal rejection and its callback; completion can win the race.
  action cancel(ref: int): bool = all {
    state.online, state.phase == "stopping", pending(state).contains(ref),
    update(state.with("cancelled", state.cancelled.union(Set(ref)))
      .with("callbacks", state.callbacks.set(ref, state.callbacks.get(ref) + 1))),
  }
  action drain(ref: int): bool = all {
    state.online, state.phase == "stopping", state.tools.contains(ref),
    update(state.with("tools", state.tools.exclude(Set(ref)))),
  }
  action settleCancelled = all {
    state.online, state.phase == "stopping", pending(state) == Set(),
    not(state.drainRequired) or state.tools == Set(),
    update(state.with("phase", "cancelled").with("settlements", state.settlements + 1)),
  }
  action settleCompleted = all {
    state.online, state.phase == "active", state.tools == Set(),
    update(state.with("phase", "completed").with("settlements", state.settlements + 1)),
  }
  action queueNext = all {
    state.online, not(state.queued), not(state.advanced), update(state.with("queued", true)),
  }
  action advance = all {
    state.online, state.queued, state.phase.in(Set("completed", "cancelled")),
    update(state.with("queued", false).with("advanced", true)),
  }
  action crash = all {
    state.online, update(state.with("online", false).with("proposals", Set()).with("discovered", Set())),
  }
  action reopen = all { not(state.online), update(state.with("online", true)) }
  action composeAny = {
    nondet ref = refs.oneOf()
    nondet parents = refs.powerset().oneOf()
    compose(ref, parents)
  }
  action projectAny = {
    nondet output = refs.powerset().oneOf()
    project(output)
  }
  action acceptAny = { nondet ref = refs.oneOf(); accept(ref) }
  action finishAny = {
    nondet ref = refs.oneOf()
    nondet output = refs.powerset().oneOf()
    finish(ref, output)
  }
  action cancelAny = { nondet ref = refs.oneOf(); cancel(ref) }
  action drainAny = { nondet ref = refs.oneOf(); drain(ref) }
  action step = any { composeAny, projectAny, discover, message, acceptAny, stop,
    finishAny, cancelAny, drainAny, settleCancelled, settleCompleted,
    queueNext, advance, crash, reopen, update(state) }
  action stepStopped = any { finishAny, cancelAny, drainAny, settleCancelled, queueNext, advance, crash, reopen, update(state) }

  val graphSound = state.dependencies.forall(link => state.nodes.contains(link._1) and state.nodes.contains(link._2) and link._1 < link._2)
  val acceptanceFenced = state.stopRecorded implies state.accepted == state.stopAccepted
  val terminalExclusive = state.completed.intersect(state.cancelled) == Set()
  val callbackAtMostOnce = refs.forall(ref => state.callbacks.get(ref) == (if (terminal(state).contains(ref)) 1 else 0))
  val settlementSound = (state.phase == "cancelled" implies pending(state) == Set()) and
    (state.phase.in(Set("completed", "cancelled")) implies state.tools == Set())
  val settlementAtMostOnce = state.settlements <= 1
  val drainingRank = state.previousStopping == 1 implies not(greater(rank(state), state.previousRank))
  val invariant = all {
    nodes.in(refs.powerset()), proposals.in(refs.powerset()), discovered.in(refs.powerset()), accepted.in(refs.powerset()), completed.in(refs.powerset()), cancelled.in(refs.powerset()), tools.in(refs.powerset()), stopAccepted.in(refs.powerset()),
    dependencies.in(links.powerset()), callbacks.in(refs.setOfMaps(0.to(1))),
    previousRank.in(tuples(0.to(3), 0.to(3), 0.to(1))), previousStopping.in(0.to(1)),
    phase.in(Set("idle", "active", "stopping", "completed", "cancelled")), settlements.in(0.to(1)),
    stopRecorded.in(Set(false, true)), queued.in(Set(false, true)), advanced.in(Set(false, true)), online.in(Set(false, true)), fenced.in(Set(false, true)), drainRequired.in(Set(false, true)),
    state.nodes.in(refs.powerset()), state.nodes.contains(0), state.dependencies.in(links.powerset()),
    state.proposals.subseteq(state.nodes), state.discovered.subseteq(state.nodes), state.accepted.subseteq(state.nodes),
    state.completed.subseteq(state.accepted), state.cancelled.subseteq(state.accepted), state.tools.subseteq(state.nodes),
    state.callbacks.in(refs.setOfMaps(0.to(1))), state.stopAccepted.subseteq(state.accepted),
    state.phase.in(Set("idle", "active", "stopping", "completed", "cancelled")), state.settlements.in(0.to(1)),
    fenced == true, drainRequired == true, state.stopRecorded == state.phase.in(Set("stopping", "cancelled")),
    state.settlements == (if (state.phase.in(Set("completed", "cancelled"))) 1 else 0),
    not(state.advanced and state.queued), state.advanced implies state.phase.in(Set("completed", "cancelled")),
    graphSound, acceptanceFenced, terminalExclusive, callbackAtMostOnce, settlementSound, settlementAtMostOnce, drainingRank,
  }
  temporal fairDrain = eventually(always(state.online)) and
    cancel(0).weakFair(state) and cancel(1).weakFair(state) and cancel(2).weakFair(state) and
    drain(0).weakFair(state) and drain(1).weakFair(state) and drain(2).weakFair(state) and settleCancelled.weakFair(state)
  temporal cancellationProgress = fairDrain implies
    (state.phase == "stopping").leadsTo(state.phase == "cancelled")
  temporal nextTurnProgress = (fairDrain and advance.weakFair(state)) implies
    (state.stopRecorded and state.queued).leadsTo(state.advanced)

  run staleDiscoveryTest = initUnfenced.then(message).then(project(Set(0))).then(discover)
    .then(stop).then(accept(0)).expect(not(acceptanceFenced))
  run undrainedSettlementTest = initUndrained.then(message).then(project(Set(0))).then(discover)
    .then(accept(0)).then(stop).then(finish(0, Set(0))).then(settleCancelled).expect(not(settlementSound))
  run completionRaceTest = init.then(message).then(project(Set(0))).then(discover)
    .then(accept(0)).then(stop).then(finish(0, Set(0))).then(drain(0)).then(settleCancelled).expect(invariant)
  run detachedCompletionTest = init.then(message).then(project(Set(0))).then(discover)
    .then(accept(0)).then(settleCompleted).then(finish(0, Set())).expect(invariant)
}
