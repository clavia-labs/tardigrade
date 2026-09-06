---------------------- MODULE IncrementalProjection ----------------------
(* IncrementalProjection models a cached fold over an append-only event log. The cache carries a watermark, snapshots preserve one cache-watermark pair, and transitions commit only while their derivation names the durable head. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS MaxLen, SkipReduce, AllowStaleCommit, SoundSnapshots

Events == {"a", "b"}
Transitions == {"hasA", "balanced"}
States == [a: 0..MaxLen, b: 0..MaxLen]
EmptyState == [a |-> 0, b |-> 0]

Step(state, event) ==
  IF event = "a"
    THEN [state EXCEPT !.a = @ + 1]
    ELSE [state EXCEPT !.b = @ + 1]

Observe(state) ==
  {transition \in Transitions:
    \/ transition = "hasA" /\ state.a > 0
    \/ transition = "balanced" /\ state.a = state.b}

(* FoldAt chooses the unique state trace produced by reducing the first position events. *)
FoldAt(events, position) ==
  LET trace == CHOOSE candidate \in [0..position -> States]:
    /\ candidate[0] = EmptyState
    /\ \A index \in 1..position:
         candidate[index] = Step(candidate[index - 1], events[index])
  IN trace[position]

VARIABLES log, cache, watermark, derived, derivedAt, derivedValid,
          snapshot, active, firing, staleCommitted

vars == <<log, cache, watermark, derived, derivedAt, derivedValid,
          snapshot, active, firing, staleCommitted>>

TypeOK ==
  /\ log \in Seq(Events)
  /\ Len(log) <= MaxLen
  /\ cache \in States
  /\ watermark \in 0..MaxLen
  /\ derived \subseteq Transitions
  /\ derivedAt \in 0..MaxLen
  /\ derivedValid \in BOOLEAN
  /\ snapshot \in [state: States, position: 0..MaxLen]
  /\ active \in BOOLEAN
  /\ firing \in Transitions \cup {"none"}
  /\ staleCommitted \in BOOLEAN

Init ==
  /\ log = <<>>
  /\ cache = EmptyState
  /\ watermark = 0
  /\ derived = {}
  /\ derivedAt = 0
  /\ derivedValid = FALSE
  /\ snapshot = [state |-> EmptyState, position |-> 0]
  /\ active = TRUE
  /\ firing = "none"
  /\ staleCommitted = FALSE

AppendEvent(event) ==
  /\ Len(log) < MaxLen
  /\ log' = Append(log, event)
  /\ UNCHANGED <<cache, watermark, derived, derivedAt, derivedValid,
                  snapshot, active, firing, staleCommitted>>

CatchUp ==
  /\ active
  /\ watermark < Len(log)
  /\ cache' = IF SkipReduce THEN cache ELSE Step(cache, log[watermark + 1])
  /\ watermark' = watermark + 1
  /\ derivedValid' = FALSE
  /\ UNCHANGED <<log, derived, derivedAt, snapshot, active, firing,
                  staleCommitted>>

DeriveCurrent ==
  /\ active
  /\ watermark = Len(log)
  /\ derived' = Observe(cache)
  /\ derivedAt' = watermark
  /\ derivedValid' = TRUE
  /\ UNCHANGED <<log, cache, watermark, snapshot, active, firing,
                  staleCommitted>>

Fire(transition) ==
  /\ active
  /\ firing = "none"
  /\ derivedValid
  /\ derivedAt = watermark
  /\ watermark = Len(log)
  /\ transition \in derived
  /\ firing' = transition
  /\ UNCHANGED <<log, cache, watermark, derived, derivedAt, derivedValid,
                  snapshot, active, staleCommitted>>

CommitFire ==
  /\ firing # "none"
  /\ AllowStaleCommit \/ derivedAt = Len(log)
  /\ staleCommitted' = (staleCommitted \/ derivedAt # Len(log))
  /\ firing' = "none"
  /\ UNCHANGED <<log, cache, watermark, derived, derivedAt, derivedValid,
                  snapshot, active>>

AbandonStaleFire ==
  /\ firing # "none"
  /\ derivedAt # Len(log)
  /\ firing' = "none"
  /\ UNCHANGED <<log, cache, watermark, derived, derivedAt, derivedValid,
                  snapshot, active, staleCommitted>>

TakeSnapshot ==
  /\ active
  /\ snapshot' =
       IF SoundSnapshots
         THEN [state |-> cache, position |-> watermark]
         ELSE [state |-> cache, position |-> Len(log)]
  /\ UNCHANGED <<log, cache, watermark, derived, derivedAt, derivedValid,
                  active, firing, staleCommitted>>

Evict ==
  /\ active
  /\ active' = FALSE
  /\ derivedValid' = FALSE
  /\ firing' = "none"
  /\ UNCHANGED <<log, cache, watermark, derived, derivedAt, snapshot,
                  staleCommitted>>

Recover ==
  /\ ~active
  /\ cache' = snapshot.state
  /\ watermark' = snapshot.position
  /\ derived' = {}
  /\ derivedAt' = snapshot.position
  /\ derivedValid' = FALSE
  /\ active' = TRUE
  /\ firing' = "none"
  /\ UNCHANGED <<log, snapshot, staleCommitted>>

Next ==
  \/ \E event \in Events: AppendEvent(event)
  \/ CatchUp
  \/ DeriveCurrent
  \/ \E transition \in Transitions: Fire(transition)
  \/ CommitFire
  \/ AbandonStaleFire
  \/ TakeSnapshot
  \/ Evict
  \/ Recover

Spec == Init /\ [][Next]_vars

(* WatermarkBound keeps the cache cursor inside the durable log. *)
WatermarkBound == watermark \in 0..Len(log)

(* CacheSound equates incremental state with complete replay of the prefix named by its watermark. *)
CacheSound == cache = FoldAt(log, watermark)

(* DerivedSound binds a valid transition set to the cached projection that produced it. *)
DerivedSound ==
  derivedValid =>
    /\ derivedAt = watermark
    /\ derived = Observe(FoldAt(log, derivedAt))

(* SnapshotSound equates a stored projection with complete replay of the prefix named by the snapshot. *)
SnapshotSound == snapshot.state = FoldAt(log, snapshot.position)

(* NoStaleCommit prevents a transition from committing after the durable log moved past its derivation. *)
NoStaleCommit == ~staleCommitted

=============================================================================
