// logCheckpoint models an append-only durable log whose entries reach storage only when durable data references them (invariant).
// Each journal event appends one deterministic entry or restarts the log as a new generation holding the previous generation's last entry; restart replaces a prefix, as compaction does.
// The runtime tracks, per generation, the length it has stored; a commit that checkpoints or accepts an input selecting a range writes entries from that mark, and other commits leave them staged.
// A crash drops staged entries and memory; restore reads the checkpointed generation and length and replays the journal suffix, which rebuilds the same log.
// referencedStored, rangesStable, and recoveryEquivalent hold; stepWriteNothing, which never writes, and stepCarryMark, whose restart keeps the previous generation's mark, must violate referencedStored.
// quint run packages/core/quint/checkpoint/logCheckpoint.qnt --invariant invariant --max-steps 30 --max-samples 20000
module logCheckpoint {
  type Range = { generation: int, start: int, end: int }
  type Log = { generation: int, entries: List[int] }
  pure val capacity = 7
  // entry is the value replay derives from the journal event at a position.
  pure def entry(position: int): int = position * 7 % 5
  // restarts says which journal positions restart the log, so replay derives the same generations.
  pure def restarts(position: int): bool = position % 3 == 2
  pure def apply(log: Log, position: int): Log =
    if (restarts(position)) { generation: log.generation + 1, entries: if (log.entries.length() > 0) List(log.entries.nth(log.entries.length() - 1)) else List() }
    else log.with("entries", log.entries.append(entry(position)))
  pure def derive(from: Log, start: int, end: int): Log = range(start, end).foldl(from, (log, position) => apply(log, position))
  pure val empty: Log = { generation: 0, entries: List() }

  var journal: int
  var log: Log
  // stored holds written entries per generation; mark is the length the runtime believes it stored for the live generation.
  var stored: int -> List[int]
  var mark: int
  var checkpoint: { generation: int, length: int, position: int }
  var ranges: List[(Range, List[int])]
  var phase: str

  action init = all {
    journal' = 0, log' = empty, stored' = 0.to(capacity).mapBy(_ => List()), mark' = 0,
    checkpoint' = { generation: 0, length: 0, position: 0 }, ranges' = List(), phase' = "live",
  }

  // write stores the live generation's entries from mark to its end.
  pure def write(stored: int -> List[int], log: Log, from: int): int -> List[int] =
    val kept = stored.get(log.generation)
    stored.set(log.generation, kept.slice(0, if (from < kept.length()) from else kept.length()).concat(log.entries.slice(from, log.entries.length())))

  action commit(writes: bool, carry: bool, chooses: bool, checkpoints: bool): bool = all {
    phase == "live", journal < capacity,
    val advanced = apply(log, journal)
    val restarted = advanced.generation != log.generation
    val from = if (restarted and not(carry)) 0 else mark
    val written = writes and (chooses or checkpoints)
    val selected = { generation: advanced.generation, start: 0, end: advanced.entries.length() }
    all {
      journal' = journal + 1, log' = advanced,
      stored' = if (written) write(stored, advanced, if (from > advanced.entries.length()) advanced.entries.length() else from) else stored,
      mark' = if (written) advanced.entries.length() else from,
      checkpoint' = if (checkpoints) { generation: advanced.generation, length: advanced.entries.length(), position: journal + 1 } else checkpoint,
      ranges' = if (chooses) ranges.append((selected, advanced.entries)) else ranges,
      phase' = phase,
    }
  }
  action crash = all { phase == "live", phase' = "down", log' = empty, mark' = 0, journal' = journal, stored' = stored, checkpoint' = checkpoint, ranges' = ranges }
  // restore reads the checkpointed generation's stored prefix, marks it stored, and replays the journal suffix.
  action restore = all {
    phase == "down",
    val base = { generation: checkpoint.generation, entries: stored.get(checkpoint.generation).slice(0, checkpoint.length) }
    all {
      val replayed = derive(base, checkpoint.position, journal)
      all {
      log' = replayed, mark' = if (replayed.generation == checkpoint.generation) checkpoint.length else 0,
      phase' = "live", journal' = journal, stored' = stored, checkpoint' = checkpoint, ranges' = ranges,
      }
    }
  }
  action stepWith(writes: bool, carry: bool): bool = any {
    nondet chooses = Bool.oneOf()
    nondet checkpoints = Bool.oneOf()
    commit(writes, carry, chooses, checkpoints),
    crash, restore,
  }
  action step = stepWith(true, false)
  action stepWriteNothing = stepWith(false, false)
  action stepCarryMark = stepWith(true, true)

  // referencedStored: the checkpointed prefix and every selected range of each generation are in storage.
  val referencedStored = checkpoint.length <= stored.get(checkpoint.generation).length()
    and ranges.indices().forall(i => ranges.nth(i)._1.end <= stored.get(ranges.nth(i)._1.generation).length())
  // rangesStable: a selected range resolves, from storage, to the values it had when accepted.
  val rangesStable = ranges.indices().forall(i => { val r = ranges.nth(i)._1 r.end > stored.get(r.generation).length() or stored.get(r.generation).slice(r.start, r.end) == ranges.nth(i)._2 })
  // recoveryEquivalent: a live log equals the log the journal derives.
  val recoveryEquivalent = phase == "live" implies log == derive(empty, 0, journal)
  val invariant = all { referencedStored, rangesStable, recoveryEquivalent }
}
