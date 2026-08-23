------------------------ MODULE ConcurrentDriver ------------------------
(* ConcurrentDriver models bounded lane settlement over one durable log.

   A dirty lane may start when the configured capacity has room. Different
   lanes may run together. A lane stays dirty while its call is running or
   its result awaits commit, so a crash loses no durable work.

   A foreground child call parks its parent. Park removes the parent from
   inFlight and records a durable blocked state. Wake follows the child's
   committed delivery and makes the parent eligible to replay.

   Results commit to one append-only log. The lane is the bounded model's
   result key, so each lane occurs at most once even when completion order
   differs from start order.

   StartUnbounded omits the capacity check. ParkLeak records the blocked
   state while retaining the live fiber. Their configurations demonstrate
   the two scheduler defects covered by this module. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Lanes, MaxConcurrent, MaxCrashes, Parkable

ASSUME Lanes /= {}
ASSUME MaxConcurrent \in Nat /\ MaxConcurrent > 0
ASSUME MaxCrashes \in Nat
ASSUME Parkable \subseteq Lanes

VARIABLES log, dirty, inFlight, ready, blocked, crashes, parks

vars == <<log, dirty, inFlight, ready, blocked, crashes, parks>>

Recorded == {log[i] : i \in DOMAIN log}

TypeOK ==
  /\ log \in Seq(Lanes)
  /\ dirty \subseteq Lanes
  /\ inFlight \subseteq Lanes
  /\ ready \subseteq Lanes
  /\ blocked \subseteq Lanes
  /\ crashes \in [Lanes -> 0..MaxCrashes]
  /\ parks \in [Lanes -> 0..1]

Init ==
  /\ log = <<>>
  /\ dirty = Lanes
  /\ inFlight = {}
  /\ ready = {}
  /\ blocked = {}
  /\ crashes = [l \in Lanes |-> 0]
  /\ parks = [l \in Lanes |-> 0]

CanStart(l) ==
  /\ l \in dirty
  /\ l \notin inFlight \cup ready \cup blocked

(* Start reserves one configured concurrency slot for a lane. *)
Start(l) ==
  /\ CanStart(l)
  /\ Cardinality(inFlight) < MaxConcurrent
  /\ inFlight' = inFlight \cup {l}
  /\ UNCHANGED <<log, dirty, ready, blocked, crashes, parks>>

(* StartUnbounded is the scheduler defect: it ignores configured capacity. *)
StartUnbounded(l) ==
  /\ CanStart(l)
  /\ inFlight' = inFlight \cup {l}
  /\ UNCHANGED <<log, dirty, ready, blocked, crashes, parks>>

(* Finish releases the live call before its keyed result commits. *)
Finish(l) ==
  /\ l \in inFlight
  /\ inFlight' = inFlight \ {l}
  /\ ready' = ready \cup {l}
  /\ UNCHANGED <<log, dirty, blocked, crashes, parks>>

(* Crash releases the slot and leaves the durable dirty debt intact. *)
Crash(l) ==
  /\ l \in inFlight
  /\ crashes[l] < MaxCrashes
  /\ inFlight' = inFlight \ {l}
  /\ crashes' = [crashes EXCEPT ![l] = @ + 1]
  /\ UNCHANGED <<log, dirty, ready, blocked, parks>>

(* Park records a durable wait and releases the parent code fiber. *)
Park(l) ==
  /\ l \in inFlight
  /\ l \in Parkable
  /\ parks[l] = 0
  /\ inFlight' = inFlight \ {l}
  /\ dirty' = dirty \ {l}
  /\ blocked' = blocked \cup {l}
  /\ parks' = [parks EXCEPT ![l] = 1]
  /\ UNCHANGED <<log, ready, crashes>>

(* ParkLeak is the fiber defect: durable blocking retains the live call. *)
ParkLeak(l) ==
  /\ l \in inFlight
  /\ l \in Parkable
  /\ parks[l] = 0
  /\ dirty' = dirty \ {l}
  /\ blocked' = blocked \cup {l}
  /\ parks' = [parks EXCEPT ![l] = 1]
  /\ UNCHANGED <<log, inFlight, ready, crashes>>

(* Wake makes a parked parent eligible after its child delivery commits. *)
Wake(l) ==
  /\ l \in blocked
  /\ blocked' = blocked \ {l}
  /\ dirty' = dirty \cup {l}
  /\ UNCHANGED <<log, inFlight, ready, crashes, parks>>

(* Commit appends the keyed result and discharges the lane's durable debt. *)
Commit(l) ==
  /\ l \in ready
  /\ log' = IF l \in Recorded THEN log ELSE Append(log, l)
  /\ ready' = ready \ {l}
  /\ dirty' = dirty \ {l}
  /\ UNCHANGED <<inFlight, blocked, crashes, parks>>

StartAny == \E l \in Lanes: Start(l)
StartUnboundedAny == \E l \in Lanes: StartUnbounded(l)
FinishAny == \E l \in Lanes: Finish(l)
CrashAny == \E l \in Lanes: Crash(l)
ParkAny == \E l \in Lanes: Park(l)
ParkLeakAny == \E l \in Lanes: ParkLeak(l)
WakeAny == \E l \in Lanes: Wake(l)
CommitAny == \E l \in Lanes: Commit(l)

Next == StartAny \/ FinishAny \/ CrashAny \/ ParkAny \/ WakeAny \/ CommitAny
UnboundedNext == StartUnboundedAny \/ FinishAny \/ CrashAny \/ ParkAny \/ WakeAny \/ CommitAny
LeakNext == StartAny \/ FinishAny \/ CrashAny \/ ParkLeakAny \/ WakeAny \/ CommitAny

Spec == Init /\ [][Next]_vars
UnboundedSpec == Init /\ [][UnboundedNext]_vars
LeakSpec == Init /\ [][LeakNext]_vars

LiveSpec ==
  /\ Spec
  /\ \A l \in Lanes: WF_vars(Start(l))
  /\ \A l \in Lanes: WF_vars(Finish(l))
  /\ \A l \in Lanes: WF_vars(Wake(l))
  /\ \A l \in Lanes: WF_vars(Commit(l))

-------------------------------------------------------------------------
(* The safety and liveness contracts. *)

ConcurrencyBound == Cardinality(inFlight) <= MaxConcurrent

LaneExclusive == inFlight \cap ready = {}

ParkReleasesFiber == blocked \cap inFlight = {}

ActiveWorkIsOwed == inFlight \cup ready \subseteq dirty

Accounting == Lanes \ Recorded = dirty \cup blocked

KeyedLog ==
  \A i, j \in DOMAIN log: log[i] = log[j] => i = j

Quiescent ==
  /\ dirty = {}
  /\ inFlight = {}
  /\ ready = {}
  /\ blocked = {}

FinalSetIndependentOfOrder == Quiescent => Recorded = Lanes

EventuallyQuiescent == <>Quiescent

=============================================================================
