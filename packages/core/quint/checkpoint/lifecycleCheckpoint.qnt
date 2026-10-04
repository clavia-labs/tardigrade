// lifecycleCheckpoint composes request acceptance, producer ownership, promise admission, and checkpoint recovery over a shared journal.
// Entries contain their effect reference; a fresh request uses its acceptance position with fixed atom and act names.
// Two durable Boolean roots and their derived projection advance at a global consumed-entry position.
// Storage commits atomically, codecs preserve state, projections are deterministic, and captured durable roots are complete.
// The finite instance has four-entry journals and one active effect; terminal requests permit reuse of the same atom and act.
// prepare maps proposalCheckpoint.qnt acceptance to runtimeCheckpoint.qnt preparation; commit and publish retain the storage boundary.
// restart and observe share effectRecovery.qnt ownership; arrive and retry share promiseDelivery.qnt admission ordering.
// TLC exhaustively checks the finite composed state space; this does not establish an unbounded composition theorem.
// Pending deliveries are volatile; eventual redelivery and scheduling fairness are outside these safety checks.
// Unread atoms, callback reconstruction, handle validation, multiple concurrent effects, and TypeScript refinement are outside this model.
// prepare corresponds to core/src/runtime/execution.ts drain and appendNow; core/src/runtime/replay.ts append validates the acceptance position and proposal.
// commit corresponds to core/src/runtime/execution.ts commit and platform/src/shared/sql-journal.ts appendWithCheckpoint; publish corresponds to snapshot assignment and sync.
// prepareCheckpoint corresponds to core/src/runtime/replay.ts checkpoint; durable roots use core/src/atoms/durable.ts schema codecs and a shared position.
// arrive and retry correspond to core/src/runtime/execution.ts send; core/src/runtime/replay.ts validatePromise rejects admission before successful effect settlement.
// crash discards volatile state; a persistence error requires reopening even when storage may already have committed.
// restore and replayNext correspond to journal.readCheckpoint, journal.readAfter, and definition.replay; expose corresponds to sync and ready completion.
// restart corresponds to snapshot.deferred and localRecovery consumption; observe corresponds to observePromises for nonlocal handles.
// Summary retains the active reference; TypeScript retains lifecycle records for every reference and admits successful immediate effects followed by domain promise settlement.
// Domain follow-ups in TypeScript share their triggering core event transaction; this model omits their payloads and treats the batch as an abstract committed transition.
// Run backend checks from a temporary directory so generated artifacts stay outside the repository.
// quint verify /absolute/path/to/lifecycleCheckpoint.qnt --backend tlc --invariant invariant
// quint run /absolute/path/to/lifecycleCheckpoint.qnt --invariant invariant --max-steps 60 --max-samples 10000 --seed 20260930
module lifecycleCheckpoint {
  type Entry = { kind: int, ref: int }
  type Summary = { position: int, status: int, ref: int, left: bool, right: bool }
  type State = {
    journal: List[Entry], checkpointPosition: int, checkpointState: Summary,
    phase: str, live: Summary, cursor: int, batch: List[Entry], prepared: Summary, save: bool,
    runningRef: int, restartPending: bool, delivery: int, deliveryRef: int, observedRef: int,
  }
  pure val capacity = 4
  // kinds encodes domain update, request, local deferred, remote deferred, immediate fulfillment, effect rejection, promise fulfillment, and promise rejection.
  pure val kinds = 0.to(7)
  pure val phases = Set("live", "prepared", "committed", "down", "replaying")
  pure val initial: Summary = { position: 0, status: 0, ref: -1, left: false, right: false }
  pure def terminal(status: int): bool = status.in(Set(4, 5, 6, 7))
  pure def quiet(s: Summary): bool = s.status == 0 or terminal(s.status)
  pure def allowed(s: Summary): Set[int] = Set(0)
    .union(if (quiet(s)) Set(1) else Set())
    .union(if (s.status == 1) Set(2, 3, 4, 5) else Set())
    .union(if (s.status.in(Set(2, 3))) Set(6, 7) else Set())
  pure def entry(s: Summary, kind: int): Entry = {
    kind: kind, ref: if (kind == 0) -1 else if (kind == 1) s.position else s.ref,
  }
  pure def reduce(s: Summary, e: Entry): Summary = {
    position: s.position + 1,
    status: if (e.kind == 0) s.status else e.kind,
    ref: if (e.kind == 1) e.ref else s.ref,
    left: if (e.kind == 0) not(s.left) else s.left,
    right: if (e.kind == 0) s.left else s.right,
  }
  pure def replay(history: List[Entry]): Summary = history.foldl(initial, (s, e) => reduce(s, e))
  pure def graph(s: Summary): (bool, bool, bool) = (s.left, s.right, s.left != s.right)
  pure val histories = 1.to(capacity).fold(Set(List()), (prefixes, _) =>
    prefixes.union(prefixes.fold(Set(List()), (output, prefix) =>
      output.union(allowed(replay(prefix)).map(kind => prefix.append(entry(replay(prefix), kind)))))))
  pure val summaries = histories.map(history => replay(history))
  pure val entries = histories.fold(Set({ kind: 0, ref: -1 }), (output, history) => history.foldl(output, (found, e) => found.union(Set(e))))
  pure val batches = entries.map(e => List(e)).union(Set(List()))

  var journal: List[Entry]
  var checkpointPosition: int
  var checkpointState: Summary
  var phase: str
  var live: Summary
  var cursor: int
  var batch: List[Entry]
  var prepared: Summary
  var save: bool
  var runningRef: int
  var restartPending: bool
  var delivery: int
  var deliveryRef: int
  var observedRef: int
  val state: State = {
    journal: journal, checkpointPosition: checkpointPosition, checkpointState: checkpointState,
    phase: phase, live: live, cursor: cursor, batch: batch, prepared: prepared, save: save,
    runningRef: runningRef, restartPending: restartPending, delivery: delivery, deliveryRef: deliveryRef, observedRef: observedRef,
  }
  action update(after: State): bool = all {
    journal' = after.journal, checkpointPosition' = after.checkpointPosition, checkpointState' = after.checkpointState,
    phase' = after.phase, live' = after.live, cursor' = after.cursor, batch' = after.batch, prepared' = after.prepared, save' = after.save,
    runningRef' = after.runningRef, restartPending' = after.restartPending, delivery' = after.delivery, deliveryRef' = after.deliveryRef, observedRef' = after.observedRef
  }
  action init = all {
    journal' = List(), checkpointPosition' = 0, checkpointState' = initial,
    phase' = "live", live' = initial, cursor' = 0, batch' = List(), prepared' = initial, save' = false,
    runningRef' = -1, restartPending' = false, delivery' = 0, deliveryRef' = -1, observedRef' = -1,
  }

  // prepare allocates request identity inside serialized admission and computes checkpoint eligibility from the candidate state.
  action prepare = {
    nondet kind = kinds.oneOf()
    val e = entry(live, kind)
    val candidate = reduce(live, e)
    all {
      phase == "live", journal.length() < capacity, allowed(live).contains(kind),
      kind.in(Set(2, 3, 4, 5)) implies runningRef == live.ref,
      kind.in(Set(6, 7)) implies delivery == kind and deliveryRef == live.ref,
      update(state.with("phase", "prepared").with("batch", List(e)).with("prepared", candidate).with("save", quiet(candidate))),
    }
  }
  action prepareCheckpoint = all {
    phase == "live", quiet(live),
    update(state.with("phase", "prepared").with("batch", List()).with("prepared", live).with("save", true)),
  }
  // commit persists the event and optional checkpoint together before live publication.
  action commit = all {
    phase == "prepared",
    update(state.with("journal", journal.concat(batch)).with("phase", "committed")
      .with("checkpointPosition", if (save) prepared.position else checkpointPosition)
      .with("checkpointState", if (save) prepared else checkpointState)),
  }
  action publish = all {
    phase == "committed",
    update(state.with("phase", "live").with("live", prepared).with("batch", List()).with("save", false)
      .with("runningRef", if (prepared.status.in(Set(1, 2))) runningRef else -1)
      .with("restartPending", restartPending and prepared.status == 2)
      .with("delivery", if (quiet(prepared)) 0 else delivery)
      .with("deliveryRef", if (quiet(prepared)) -1 else deliveryRef)),
  }
  action dispatch = all {
    phase == "live", live.status == 1, runningRef == -1,
    update(state.with("runningRef", live.ref)),
  }
  action restart = all {
    phase == "live", live.status == 2, restartPending, runningRef == -1,
    update(state.with("runningRef", live.ref).with("restartPending", false)),
  }
  action observe = all {
    phase == "live", live.status == 3,
    update(state.with("observedRef", live.ref)),
  }
  // arrive allows a producer result before effect settlement and leaves committed state unchanged.
  action arrive = {
    nondet result = Set(6, 7).oneOf()
    all {
      phase.in(Set("live", "prepared", "committed")), delivery == 0,
      live.status.in(Set(1, 2, 3)),
      update(state.with("delivery", result).with("deliveryRef", live.ref)),
    }
  }
  // retry releases admission without discarding a result waiting for EffectSettled.
  action retry = all {
    phase == "live", delivery != 0, live.status == 1,
    update(state),
  }
  action crash = update(state.with("phase", "down").with("live", initial).with("cursor", 0)
    .with("batch", List()).with("prepared", initial).with("save", false)
    .with("runningRef", -1).with("restartPending", false).with("delivery", 0).with("deliveryRef", -1).with("observedRef", -1))
  action restore = all {
    phase == "down",
    update(state.with("phase", "replaying").with("live", checkpointState).with("cursor", checkpointPosition)),
  }
  action replayNext = all {
    phase == "replaying", cursor < journal.length(),
    update(state.with("live", reduce(live, journal.nth(cursor))).with("cursor", cursor + 1)),
  }
  action expose = all {
    phase == "replaying", cursor == journal.length(),
    update(state.with("phase", "live").with("restartPending", live.status == 2)),
  }
  action step = any { prepare, prepareCheckpoint, commit, publish, dispatch, restart, observe, arrive, retry, crash, restore, replayNext, expose }

  pure def ordered(history: List[Entry]): bool = history.indices().forall(i => {
    val e = history.nth(i)
    val prefix = replay(history.slice(0, i))
    allowed(prefix).contains(e.kind) and e == entry(prefix, e.kind)
  })
  val acceptanceAtomic = journal.indices().forall(i => journal.nth(i).kind == 1 implies journal.nth(i).ref == i)
    and (phase == "prepared" and batch.length() == 1 and batch.nth(0).kind == 1 implies batch.nth(0).ref == journal.length())
  val settlementFirst = journal.indices().forall(i => journal.nth(i).kind.in(Set(6, 7)) implies {
    val prefix = replay(journal.slice(0, i))
    prefix.status.in(Set(2, 3)) and prefix.ref == journal.nth(i).ref
  })
  val checkpointSound = checkpointState == replay(journal.slice(0, checkpointPosition))
  val checkpointQuiescent = quiet(checkpointState)
  val visibleEquivalent = phase.in(Set("live", "prepared")) implies
    live == replay(journal) and graph(live) == graph(replay(journal))
  val localRestartOnly = restartPending implies live.status == 2 and runningRef == -1
  val invariant = all {
    journal.in(histories), checkpointPosition.in(0.to(capacity)), checkpointPosition <= journal.length(),
    checkpointState.in(summaries), live.in(summaries), prepared.in(summaries), phase.in(phases), cursor.in(0.to(capacity)),
    batch.in(batches), save.in(Set(false, true)), runningRef.in((-1).to(capacity - 1)), restartPending.in(Set(false, true)),
    delivery.in(Set(0, 6, 7)), deliveryRef.in((-1).to(capacity - 1)), observedRef.in((-1).to(capacity - 1)),
    ordered(journal), acceptanceAtomic, settlementFirst, checkpointSound, checkpointQuiescent, visibleEquivalent, localRestartOnly,
    (delivery == 0) == (deliveryRef == -1),
    delivery != 0 implies deliveryRef == live.ref,
    runningRef != -1 implies runningRef == live.ref and live.status.in(Set(1, 2)),
    phase == "prepared" implies all {
      journal.length() + batch.length() <= capacity, prepared == replay(journal.concat(batch)),
      ordered(journal.concat(batch)), save == quiet(prepared),
    },
    phase == "committed" implies all { prepared == replay(journal), save == quiet(prepared) },
    phase == "replaying" implies all {
      checkpointPosition <= cursor, cursor <= journal.length(), live == replay(journal.slice(0, cursor)),
      runningRef == -1, not(restartPending), delivery == 0,
    },
    phase == "down" implies all { live == initial, runningRef == -1, not(restartPending), delivery == 0 },
  }
}
