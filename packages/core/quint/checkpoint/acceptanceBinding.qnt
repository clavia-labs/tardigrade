// acceptanceBinding models journal-backed invocation admission and reference allocation (invariant).
// Two invocations share an atom, act, and input; a third uses another atom with the same act and input.
// Invocation identity is (atom, act, origin); Ref.seq identifies the later acceptance event.
// Two initial domain events provide origins; owner numbers select invocation tuples and inputs are abstracted as equal.
// Acceptance stores invocation identity and assigned reference atomically in a framework receipt.
// Empty working sets permit actor-state checkpoints; suffix replay reconstructs bindings before exposing requests.
// Proposals may repeat after completion or recovery; admission consults the full journal independently of actor withdrawal.
// Live bindings retain unfinished work; payload verification, execution, cleanup, and TypeScript refinement remain separate contracts.
// quint verify /absolute/path/to/acceptanceBinding.qnt --backend tlc --invariant invariant
// stepSplitCommit, stepDropActorState, stepPendingCheckpoint, stepSwapBindings, stepReacceptCompleted, and stepResumeCompleted must violate invariant.
module acceptanceBinding {
  type Invocation = { atom: str, act: str, origin: int }
  type Ref = { seq: int, atom: str, act: str }
  type Entry = { kind: str, owner: int, ref: Ref, receipt: bool }
  type Bindings = int -> Ref
  type Decision = { owner: int, kind: str, ref: Ref, position: int }
  type State = {
    journal: List[Entry], staged: int, phase: str,
    live: Bindings, actors: Set[int], checkpoint: Set[int], checkpointPosition: int, cursor: int,
    decision: Decision,
  }
  pure val owners = Set(0, 1, 2)
  pure val capacity = 6
  pure def invocation(owner: int): Invocation = {
    atom: if (owner < 2) "notifier" else "other", act: "sendMessage", origin: if (owner == 1) 1 else 0,
  }
  pure def reference(position: int, owner: int): Ref = {
    seq: position, atom: invocation(owner).atom, act: invocation(owner).act,
  }
  pure val noDecision: Decision = { owner: -1, kind: "none", ref: reference(0, 0), position: 0 }
  pure val domain: Entry = { kind: "domain", owner: -1, ref: reference(0, 0), receipt: false }
  pure def bindings(history: List[Entry], receiptsOnly: bool): Bindings = history.foldl(Map(), (result, entry) =>
    if (entry.kind == "requested" and (not(receiptsOnly) or entry.receipt)) result.put(entry.owner, entry.ref) else result)
  pure def accepted(history: List[Entry]): Bindings = bindings(history, false)
  pure def project(history: List[Entry]): Bindings = bindings(history, true)
  pure def completed(history: List[Entry], owner: int): bool = history.indices().exists(i => {
    val entry = history.nth(i)
    entry.kind == "completed" and entry.owner == owner and entry.receipt
  })
  pure def unfinished(history: List[Entry]): Set[int] = project(history).keys().filter(owner => not(completed(history, owner)))
  pure def activeProject(history: List[Entry]): Bindings = unfinished(history).mapBy(owner => project(history).get(owner))

  pure def actorProjection(history: List[Entry]): Set[int] = owners.filter(owner => completed(history, owner))

  var state: State
  action init = state' = {
    journal: List(domain, domain), staged: -1, phase: "live", live: Map(),
    actors: Set(), checkpoint: Set(), checkpointPosition: 0, cursor: 0,
    decision: noDecision,
  }

  // prepareOwner reserves serialized admission after a successful lookup reports absence.
  action prepareOwner(owner: int, fullJournal: bool): bool = all {
    state.phase == "live", state.staged == -1, state.journal.length() < capacity,
    not((if (fullJournal) project(state.journal).keys() else unfinished(state.journal)).contains(owner)),
    state' = state.with("staged", owner),
  }
  action prepare = {
    nondet owner = owners.oneOf()
    prepareOwner(owner, true)
  }
  // admitExisting resolves repeated proposals without appending another acceptance.
  action admitExisting(owner: int, respectCompletion: bool): bool = all {
    state.phase == "live", state.staged == -1, project(state.journal).keys().contains(owner),
    state' = state.with("decision", { owner: owner, kind: if (respectCompletion and completed(state.journal, owner)) "skip" else "resume",
      ref: project(state.journal).get(owner), position: state.journal.length() }),
  }
  action repeatProposal = {
    nondet owner = owners.oneOf()
    admitExisting(owner, true)
  }
  // abort leaves acceptance and domain bindings unchanged after a failed transaction.
  action abort = all {
    state.phase == "live", state.staged >= 0,
    state' = state.with("staged", -1),
  }
  action commitWithReceipt(atomic: bool): bool = all {
    state.phase == "live", state.staged >= 0, state.journal.length() < capacity,
    val ref = reference(state.journal.length(), state.staged)
    state' = state.with("journal", state.journal.append({ kind: "requested", owner: state.staged, ref: ref, receipt: atomic }))
      .with("live", if (atomic) state.live.put(state.staged, ref) else state.live)
      .with("decision", { owner: state.staged, kind: "new", ref: ref, position: state.journal.length() }).with("staged", -1),
  }
  action commit = commitWithReceipt(true)
  // complete records a terminal invocation; execution and domain outcome payloads are abstracted.
  action complete(owner: int): bool = all {
    state.phase == "live", state.staged == -1, state.journal.length() < capacity,
    unfinished(state.journal).contains(owner),
    state' = state.with("journal", state.journal.append({ kind: "completed", owner: owner, ref: project(state.journal).get(owner), receipt: true }))
      .with("live", state.live.keys().exclude(Set(owner)).mapBy(key => state.live.get(key)))
      .with("actors", state.actors.union(Set(owner))),
  }
  action completeAny = {
    nondet owner = owners.oneOf()
    complete(owner)
  }
  // update advances journal position while a proposal can remain unaccepted.
  action update = all {
    state.phase == "live", state.journal.length() < capacity,
    state' = state.with("journal", state.journal.append(domain)),
  }
  action captureWithActors(retain: bool, requireEmpty: bool): bool = all {
    state.phase == "live", state.staged == -1, not(requireEmpty) or state.live == Map(),
    state' = state.with("checkpointPosition", state.journal.length())
      .with("checkpoint", if (retain) state.actors else Set()),
  }
  action capture = captureWithActors(true, true)
  action crash = all {
    state.phase == "live",
    state' = state.with("phase", "down").with("live", Map()).with("staged", -1).with("cursor", 0).with("decision", noDecision).with("actors", Set()),
  }
  action restore = all {
    state.phase == "down",
    state' = state.with("phase", "replay").with("live", Map()).with("actors", state.checkpoint).with("cursor", state.checkpointPosition),
  }
  action replayNext = all {
    state.phase == "replay", state.cursor < state.journal.length(),
    val entry = state.journal.nth(state.cursor)
    state' = state.with("live", if (entry.kind == "requested" and entry.receipt) state.live.put(entry.owner, entry.ref) else if (entry.kind == "completed" and entry.receipt) state.live.keys().exclude(Set(entry.owner)).mapBy(owner => state.live.get(owner)) else state.live)
      .with("actors", if (entry.kind == "completed" and entry.receipt) state.actors.union(Set(entry.owner)) else state.actors)
      .with("cursor", state.cursor + 1),
  }
  action expose = all {
    state.phase == "replay", state.cursor == state.journal.length(),
    state' = state.with("phase", "live"),
  }
  // swapBindings represents recovery guessing between identical calls to the same operation.
  action swapBindings = all {
    state.phase == "live", Set(0, 1).subseteq(state.live.keys()),
    state' = state.with("live", state.live.put(0, state.live.get(1)).put(1, state.live.get(0))),
  }
  action step = any { prepare, repeatProposal, abort, commit, completeAny, update, capture, crash, restore, replayNext, expose }
  action stepSplitCommit = any { step, commitWithReceipt(false) }
  action stepDropActorState = any { step, captureWithActors(false, true) }
  action stepPendingCheckpoint = any { step, captureWithActors(true, false) }
  action stepSwapBindings = any { step, swapBindings }
  action stepReacceptCompleted = {
    nondet owner = owners.oneOf()
    any { step, prepareOwner(owner, false) }
  }
  action stepResumeCompleted = {
    nondet owner = owners.oneOf()
    any { step, admitExisting(owner, false) }
  }

  val requestPositions = state.journal.indices().filter(i => state.journal.nth(i).kind == "requested")
  val acceptanceIdentity = requestPositions.forall(i => state.journal.nth(i).ref == reference(i, state.journal.nth(i).owner))
    and requestPositions.forall(i => invocation(state.journal.nth(i).owner).origin < i)
  val uniqueReferences = requestPositions.forall(i => requestPositions.forall(j =>
    i == j or state.journal.nth(i).ref != state.journal.nth(j).ref))
  val uniqueInvocations = requestPositions.forall(i => requestPositions.forall(j =>
    i == j or invocation(state.journal.nth(i).owner) != invocation(state.journal.nth(j).owner)))
  val acceptanceAtomic = project(state.journal) == accepted(state.journal)
  val checkpointSound = state.checkpoint == actorProjection(state.journal.slice(0, state.checkpointPosition)) and activeProject(state.journal.slice(0, state.checkpointPosition)) == Map()
  val recoveryEquivalent = state.phase == "live" implies state.live == activeProject(state.journal) and state.actors == actorProjection(state.journal)
  val replayPrefix = state.phase == "replay" implies state.live == activeProject(state.journal.slice(0, state.cursor)) and state.actors == actorProjection(state.journal.slice(0, state.cursor))
  val admissionSound = state.decision.kind == "none" or {
    val decision = state.decision
    val before = state.journal.slice(0, decision.position)
    val requests = before.indices().filter(i => before.nth(i).kind == "requested" and invocation(before.nth(i).owner) == invocation(decision.owner))
    if (decision.kind == "new") requests == Set() and decision.ref == reference(decision.position, decision.owner)
    else requests.size() == 1 and requests.forall(i => before.nth(i).ref == decision.ref)
      and (decision.kind == "skip") == before.indices().exists(i => before.nth(i).kind == "completed" and before.nth(i).ref == decision.ref)
  }
  val activeOnly = state.phase == "live" implies state.live.keys() == unfinished(state.journal)
  val invariant = all {
    acceptanceIdentity, uniqueReferences, uniqueInvocations, acceptanceAtomic, checkpointSound, recoveryEquivalent, replayPrefix, admissionSound, activeOnly,
  }

  val checkpointReady = state.phase == "live" and state.staged == -1 and state.live == Map()
  run pendingCheckpointTest = init.then(prepareOwner(0, true)).then(commit).expect(invariant and not(checkpointReady))
  run unfinishedProposalTest = init.then(prepareOwner(0, true)).then(commit).then(admitExisting(0, true))
    .expect(invariant and state.decision.kind == "resume" and state.decision.ref == reference(2, 0) and state.journal.length() == 3)
  run completedProposalTest = init.then(prepareOwner(0, true)).then(commit).then(complete(0)).then(admitExisting(0, true))
    .expect(invariant and state.live == Map() and state.decision.kind == "skip" and state.journal.length() == 4)
    .then(capture).then(crash).then(restore).then(expose).then(admitExisting(0, true))
    .expect(invariant and state.live == Map() and state.decision.kind == "skip" and state.decision.ref == reference(2, 0) and state.journal.length() == 4)
  run distinctInvocationsTest = init.then(prepareOwner(0, true)).then(commit).then(prepareOwner(1, true)).then(commit)
    .then(prepareOwner(2, true)).then(commit)
    .expect(invariant and accepted(state.journal).keys() == owners)
  run abortedAdmissionTest = init.then(prepareOwner(0, true)).then(abort).then(prepareOwner(0, true)).then(commit)
    .expect(invariant and state.journal.length() == 3 and state.decision.ref == reference(2, 0))
}
