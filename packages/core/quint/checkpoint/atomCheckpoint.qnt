// atomCheckpoint models capture and incremental recovery for a deterministic atom (recoveryEquivalent).
// The reducer is order-sensitive; events are bounded integers and journal capacity bounds this model.
// The codec preserves state by assumption; effect lifecycles and TypeScript refinement are outside this model.
// Quint 0.32.0 with Apalache 0.56.1 checks initialization, preservation, and implication of both safety properties.
// The checked domain has journals of up to three events; the induction does not bound the number of transitions.
// Run verification in a temporary directory to keep checker artifacts outside the repository:
// checkpoint_model="$PWD/packages/core/quint/checkpoint/atomCheckpoint.qnt"
// verification_dir=$(mktemp -d /tmp/tardigrade-quint-checkpoint.XXXXXX)
// (cd "$verification_dir" && JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home quint verify "$checkpoint_model" --inductive-invariant=invariant --invariants checkpointSound recoveryEquivalent)
module atomCheckpoint {
  pure val capacity = 3
  pure val events = Set(-1, 0, 1)
  pure val histories = 1.to(capacity).fold(Set(List()), (prefixes, _) =>
    prefixes.union(prefixes.fold(Set(List()), (output, prefix) =>
      output.union(events.map(event => prefix.append(event))))))
  pure def reduce(state: int, event: int): int = state * 2 + event
  pure def replay(history: List[int]): int = history.foldl(0, (state, event) => reduce(state, event))
  pure def encode(state: int): int = state
  pure def decode(encoded: int): int = encoded

  var journal: List[int]
  // live retains reference state during recovery for comparison; recovered is the reconstructed atom state.
  var live: int
  var checkpointPosition: int
  var checkpointState: int
  var recovering: bool
  var cursor: int
  var recovered: int

  type Frame = { journal: List[int], live: int, checkpointPosition: int, checkpointState: int, recovering: bool, cursor: int, recovered: int }
  val frame: Frame = { journal: journal, live: live, checkpointPosition: checkpointPosition, checkpointState: checkpointState, recovering: recovering, cursor: cursor, recovered: recovered }
  action update(after: Frame): bool = all {
    journal' = after.journal, live' = after.live, checkpointPosition' = after.checkpointPosition, checkpointState' = after.checkpointState, recovering' = after.recovering, cursor' = after.cursor, recovered' = after.recovered
  }

  action init = all {
    journal' = List(), live' = 0,
    checkpointPosition' = 0, checkpointState' = encode(0),
    recovering' = false, cursor' = 0, recovered' = 0,
  }

  action commitEvent(event: int): bool = all {
    not(recovering), journal.length() < capacity,
    update(frame.with("journal", journal.append(event)).with("live", reduce(live, event))),
  }

  action capture = all {
    not(recovering),
    update(frame.with("checkpointPosition", journal.length()).with("checkpointState", encode(live))),
  }

  // crash discards the recovery cursor and starts again from the persisted checkpoint.
  action crash = all {
    update(frame.with("recovering", true).with("cursor", checkpointPosition).with("recovered", decode(checkpointState))),
  }

  action replayNext = all {
    recovering, cursor < journal.length(),
    update(frame.with("recovered", reduce(recovered, journal.nth(cursor))).with("cursor", cursor + 1)),
  }

  action resume = all {
    recovering, cursor == journal.length(),
    update(frame.with("live", recovered).with("recovering", false)),
  }

  action step = {
    nondet event = events.oneOf()
    any { commitEvent(event), capture, crash, replayNext, resume }
  }

  val checkpointSound = decode(checkpointState) == replay(journal.slice(0, checkpointPosition))
  val recoveryEquivalent = (recovering and cursor == journal.length()) implies recovered == replay(journal)
  val invariant = all {
    journal.in(histories),
    checkpointPosition.in(0.to(capacity)), checkpointPosition <= journal.length(),
    cursor.in(0.to(capacity)), cursor <= journal.length(),
    checkpointState.in((-31).to(31)),
    recovered.in((-31).to(31)),
    recovering.in(Set(false, true)),
    live == replay(journal),
    checkpointSound,
    recovering implies all {
      checkpointPosition <= cursor,
      recovered == replay(journal.slice(0, cursor)),
    },
  }
}
