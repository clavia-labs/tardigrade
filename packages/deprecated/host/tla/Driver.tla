----------------------------- MODULE Driver -----------------------------
(* The fairness ledger: the platform half of the deriver design. The
   threads derive owed work (Reconcile.tla); nothing in that algebra makes
   work RUN. Liveness is bought by a driver with one alarm, and this
   module itemizes what the driver owes:

   ACCOUNTING: while any thread owes work, a wake is coming: the alarm is
     armed or a pass is in flight. The alarm is deleted only over a
     truly quiet host. (The 2026-08-15 freeze was this debt unpaid
     against an incorrect resting(); Reconcile.tla makes resting honest, and
     this module makes the arming honest against crashes and races.)

   REDRIVE: a crashed visit loses no work. The thread's owed derivation
     survives the crash, and the next pass retries it. This is the
     WF_vars(RunAct) assumption of the machine specs, finally paid by a
     mechanism instead of assumed.

   SERVICE: every owed thread is eventually served, whatever the other
     threads do: crashes bounded, arrivals adversarial, passes recurring.

   REST: a thread whose visits always crash eventually settles as
     failed and goes quiet. GiveUp pays it: a per-thread tries counter
     rises on each zero-progress attempt and any progress clears it,
     and at the limit the driver discharges the thread as failed. The
     counter's key is the log length: the log is append-only, so an
     unchanged length across an attempt IS zero progress, and the
     give-up itself is one more append (the failed CodeSettled).
     DriverPoisoned.cfg checks it over a poisoned thread.

   THE MODEL. Threads' owed work is a boolean derivation (the abstraction
   of Reconcile.tla's enabled work). Arrive raises it and arms the alarm (the
   deliver contract: every append arms). Fire consumes the alarm and
   opens a pass over every thread. A visit serves its thread, crashes, or
   gives up at the tries limit; every way it leaves the pass. The pass
   ends with a re-arm, and the
   re-arm is where drivers die, so it comes in two shapes:

   ReArm (the contract): fold the live owed derivations in, and keep
     any arming that happened mid-pass. armed' = armed \/ \E owed.
   ReArmDrop (the defect): recompute from the answers the pass itself
     collected. A thread that crashed contributed no answer; a thread whose
     work arrived after its visit answered "quiet". Both drop the arm:
     Accounting fails. This is the 2026-08-10 grading incident
     when an arrival or failed visit contributes no answer. *)

EXTENDS Naturals, FiniteSets, TLC

(* Poisoned threads model the deterministic crasher: a visit that can
   never serve (the Uniconnect run facet, 2026-08-18). Their crashes
   are free: the MaxCrashes budget bounds only transient failures, so
   the budget cannot smuggle convergence past a thread that never
   converges. *)
CONSTANTS Threads, MaxCrashes, Poisoned, GiveUpLimit

ASSUME Poisoned \subseteq Threads
ASSUME GiveUpLimit \in Nat /\ GiveUpLimit > 0

(* tries counts a thread's consecutive zero-progress attempts: the
   abstraction of the (facet, log length) key. A crash appended
   nothing, so it raises the count; a serve is progress and clears
   it; so does a fresh arrival, because an arrival is an append and
   the next attempt reads a new length. *)
VARIABLES owed, armed, inPass, queue, answers, crashes, tries

vars == <<owed, armed, inPass, queue, answers, crashes, tries>>

TypeOK ==
  /\ owed \in [Threads -> BOOLEAN]
  /\ armed \in BOOLEAN
  /\ inPass \in BOOLEAN
  /\ queue \subseteq Threads
  /\ answers \in [Threads -> BOOLEAN]
  /\ crashes \in 0..MaxCrashes
  /\ tries \in [Threads -> 0..GiveUpLimit]

Init ==
  /\ owed = [l \in Threads |-> FALSE]
  /\ armed = FALSE
  /\ inPass = FALSE
  /\ queue = {}
  /\ answers = [l \in Threads |-> FALSE]
  /\ crashes = 0
  /\ tries = [l \in Threads |-> 0]

(* Work arrives on a thread, any time, mid-pass included. The deliver
   contract: every arrival arms. *)
Arrive(l) ==
  /\ ~owed[l]
  /\ owed' = [owed EXCEPT ![l] = TRUE]
  /\ armed' = TRUE
  /\ tries' = [tries EXCEPT ![l] = 0]
  /\ UNCHANGED <<inPass, queue, answers, crashes>>

(* The alarm fires: consume the arm, open a pass over every thread. *)
Fire ==
  /\ armed
  /\ ~inPass
  /\ armed' = FALSE
  /\ inPass' = TRUE
  /\ queue' = Threads
  /\ UNCHANGED <<owed, answers, crashes, tries>>

(* A visit serves its thread: owed work discharges, and the thread answers
   the pass "quiet as of my visit". *)
VisitOk(l) ==
  /\ inPass
  /\ l \in queue
  /\ l \notin Poisoned
  /\ owed' = [owed EXCEPT ![l] = FALSE]
  /\ answers' = [answers EXCEPT ![l] = FALSE]
  /\ queue' = queue \ {l}
  /\ tries' = [tries EXCEPT ![l] = 0]
  /\ UNCHANGED <<armed, inPass, crashes>>

(* A visit crashes: the thread's owed derivation is untouched (REDRIVE:
   the log lost nothing, the derivation re-raises the work), and the
   thread contributes no answer to the pass. *)
VisitCrash(l) ==
  /\ inPass
  /\ l \in queue
  /\ (l \in Poisoned \/ crashes < MaxCrashes)
  /\ tries[l] < GiveUpLimit
  /\ answers' = [answers EXCEPT ![l] = FALSE]
  /\ queue' = queue \ {l}
  /\ crashes' = IF l \in Poisoned THEN crashes ELSE crashes + 1
  /\ tries' = [tries EXCEPT ![l] = @ + 1]
  /\ UNCHANGED <<owed, armed, inPass>>

(* A visit gives up: the tries limit is reached, so the driver
   discharges the thread as failed instead of retrying. The discharge
   is an append like any other (the failed CodeSettled), so REDRIVE
   is not violated: the log records the failure, and a later arrival
   starts the thread fresh. *)
VisitGiveUp(l) ==
  /\ inPass
  /\ l \in queue
  /\ tries[l] = GiveUpLimit
  /\ owed' = [owed EXCEPT ![l] = FALSE]
  /\ answers' = [answers EXCEPT ![l] = FALSE]
  /\ queue' = queue \ {l}
  /\ tries' = [tries EXCEPT ![l] = 0]
  /\ UNCHANGED <<armed, inPass, crashes>>

(* The contract re-arm: live derivations folded in, mid-pass arms kept. *)
ReArm ==
  /\ inPass
  /\ queue = {}
  /\ inPass' = FALSE
  /\ armed' = (armed \/ \E l \in Threads: owed[l])
  /\ UNCHANGED <<owed, queue, answers, crashes, tries>>

(* The defective re-arm: trust only the pass's own answers. *)
ReArmDrop ==
  /\ inPass
  /\ queue = {}
  /\ inPass' = FALSE
  /\ armed' = (\E l \in Threads: answers[l])
  /\ UNCHANGED <<owed, queue, answers, crashes, tries>>

ArriveAny == \E l \in Threads: Arrive(l)
VisitAny  == \E l \in Threads: VisitOk(l) \/ VisitCrash(l) \/ VisitGiveUp(l)

Next     == ArriveAny \/ Fire \/ VisitAny \/ ReArm
NextDrop == ArriveAny \/ Fire \/ VisitAny \/ ReArmDrop

Spec     == Init /\ [][Next]_vars
DropSpec == Init /\ [][NextDrop]_vars

(* Liveness: fair firing and pass-closing; visits strongly fair (a
   thread's visit is enabled once per pass, intermittently, so weak
   fairness is not enough). Crashes are bounded, so retries converge. *)
LiveSpec ==
  /\ Spec
  /\ WF_vars(Fire)
  /\ WF_vars(ReArm)
  /\ \A l \in Threads: SF_vars(VisitOk(l))
  (* Every queued thread is eventually visited: a visit completes, by
     serve, by crash, or by give-up. This is the fail-fast
     assumption. A visit that HANGS holds the pass open past this
     module's model; the runtime's alarm time limit owns that door,
     unmodeled here. *)
  /\ \A l \in Threads: WF_vars(VisitOk(l) \/ VisitCrash(l) \/ VisitGiveUp(l))

-----------------------------------------------------------------------
(* The debts. *)

(* ACCOUNTING: owed work always has a wake coming. *)
Accounting == (\E l \in Threads: owed[l]) => (armed \/ inPass)

(* SERVICE and REST (under LiveSpec): every owed thread eventually
   rests, served or settled as failed. GiveUp is what carries the
   poisoned case: crashes are unbounded there, and the tries limit
   converts the eternal retry into a discharge. DriverPoisoned.cfg
   checks the poisoned case; DriverLive.cfg the healthy one. *)
EventuallyServed == \A l \in Threads: [](owed[l] => <>(~owed[l]))

(* ISOLATION (under LiveSpec): every healthy thread is eventually
   served, whatever the poisoned threads do. The implementation half is
   the per-visit catch in HostSupervisor.alarm: before it, one
   poisoned facet failed the whole pass and starved every thread (the
   2026-08-18 Uniconnect wedge). *)
HealthyServed == \A l \in (Threads \ Poisoned): [](owed[l] => <>(~owed[l]))

=======================================================================
