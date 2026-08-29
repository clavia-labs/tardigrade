------------------------ MODULE ConcurrentDriver ------------------------
(* ConcurrentDriver models bounded thread settlement over one durable log.

   A dirty thread may start when the configured capacity has room. Different
   threads may run together. A thread stays dirty while its call is running or
   its result awaits commit, so a crash loses no durable work.

   A foreground child call parks its parent. Park removes the parent from
   inFlight and records a durable blocked state. Wake follows the child's
   committed delivery and makes the parent eligible to replay.

   Results commit to one append-only log. The thread is the bounded model's
   result key, so each thread occurs at most once even when completion order
   differs from start order.

   StartUnbounded omits the capacity check. ParkLeak records the blocked
   state while retaining the live fiber. Their configurations demonstrate
   the two scheduler defects covered by this module. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Threads, MaxConcurrent, MaxCrashes, Parkable

ASSUME Threads /= {}
ASSUME MaxConcurrent \in Nat /\ MaxConcurrent > 0
ASSUME MaxCrashes \in Nat
ASSUME Parkable \subseteq Threads

VARIABLES log, dirty, inFlight, ready, blocked, crashes, parks

vars == <<log, dirty, inFlight, ready, blocked, crashes, parks>>

Recorded == {log[i] : i \in DOMAIN log}

TypeOK ==
  /\ log \in Seq(Threads)
  /\ dirty \subseteq Threads
  /\ inFlight \subseteq Threads
  /\ ready \subseteq Threads
  /\ blocked \subseteq Threads
  /\ crashes \in [Threads -> 0..MaxCrashes]
  /\ parks \in [Threads -> 0..1]

Init ==
  /\ log = <<>>
  /\ dirty = Threads
  /\ inFlight = {}
  /\ ready = {}
  /\ blocked = {}
  /\ crashes = [l \in Threads |-> 0]
  /\ parks = [l \in Threads |-> 0]

CanStart(l) ==
  /\ l \in dirty
  /\ l \notin inFlight \cup ready \cup blocked

(* Start reserves one configured concurrency slot for a thread. *)
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

(* Commit appends the keyed result and discharges the thread's durable debt. *)
Commit(l) ==
  /\ l \in ready
  /\ log' = IF l \in Recorded THEN log ELSE Append(log, l)
  /\ ready' = ready \ {l}
  /\ dirty' = dirty \ {l}
  /\ UNCHANGED <<inFlight, blocked, crashes, parks>>

StartAny == \E l \in Threads: Start(l)
StartUnboundedAny == \E l \in Threads: StartUnbounded(l)
FinishAny == \E l \in Threads: Finish(l)
CrashAny == \E l \in Threads: Crash(l)
ParkAny == \E l \in Threads: Park(l)
ParkLeakAny == \E l \in Threads: ParkLeak(l)
WakeAny == \E l \in Threads: Wake(l)
CommitAny == \E l \in Threads: Commit(l)

Next == StartAny \/ FinishAny \/ CrashAny \/ ParkAny \/ WakeAny \/ CommitAny
UnboundedNext == StartUnboundedAny \/ FinishAny \/ CrashAny \/ ParkAny \/ WakeAny \/ CommitAny
LeakNext == StartAny \/ FinishAny \/ CrashAny \/ ParkLeakAny \/ WakeAny \/ CommitAny

Spec == Init /\ [][Next]_vars
UnboundedSpec == Init /\ [][UnboundedNext]_vars
LeakSpec == Init /\ [][LeakNext]_vars

LiveSpec ==
  /\ Spec
  /\ \A l \in Threads: WF_vars(Start(l))
  /\ \A l \in Threads: WF_vars(Finish(l))
  /\ \A l \in Threads: WF_vars(Wake(l))
  /\ \A l \in Threads: WF_vars(Commit(l))

-------------------------------------------------------------------------
(* The safety and liveness contracts. *)

ConcurrencyBound == Cardinality(inFlight) <= MaxConcurrent

ThreadExclusive == inFlight \cap ready = {}

ParkReleasesFiber == blocked \cap inFlight = {}

ActiveWorkIsOwed == inFlight \cup ready \subseteq dirty

Accounting == Threads \ Recorded = dirty \cup blocked

KeyedLog ==
  \A i, j \in DOMAIN log: log[i] = log[j] => i = j

Quiescent ==
  /\ dirty = {}
  /\ inFlight = {}
  /\ ready = {}
  /\ blocked = {}

FinalSetIndependentOfOrder == Quiescent => Recorded = Threads

EventuallyQuiescent == <>Quiescent

=============================================================================
