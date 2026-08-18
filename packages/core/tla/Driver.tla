----------------------------- MODULE Driver -----------------------------
(* The fairness ledger: the platform half of the deriver design. The
   lanes derive owed work (Reactor.tla); nothing in that algebra makes
   work RUN. Liveness is bought by a driver with one alarm, and this
   module itemizes what the driver owes:

   ACCOUNTING: while any lane owes work, a wake is coming: the alarm is
     armed or a pass is in flight. The alarm is deleted only over a
     truly quiet host. (The 2026-08-15 freeze was this debt unpaid
     against a lying resting(); Reactor.tla makes resting honest, and
     this module makes the arming honest against crashes and races.)

   REDRIVE: a crashed visit loses no work. The lane's owed derivation
     survives the crash, and the next pass retries it. This is the
     WF_vars(RunAct) assumption of the machine specs, finally paid by a
     mechanism instead of assumed.

   SERVICE: every owed lane is eventually served, whatever the other
     lanes do: crashes bounded, arrivals adversarial, passes recurring.

   THE MODEL. Lanes' owed work is a boolean derivation (the abstraction
   of Reactor.tla's WorkOwed). Arrive raises it and arms the alarm (the
   deliver contract: every append arms). Fire consumes the alarm and
   opens a pass over every lane. A visit serves its lane or crashes;
   either way it leaves the pass. The pass ends with a re-arm, and the
   re-arm is where drivers die, so it comes in two shapes:

   ReArm (the contract): fold the live owed derivations in, and keep
     any arming that happened mid-pass. armed' = armed \/ \E owed.
   ReArmDrop (the defect): recompute from the answers the pass itself
     collected. A lane that crashed contributed no answer; a lane whose
     work arrived after its visit answered "quiet". Both drop the arm:
     Accounting fails. This is the 2026-08-10 grading incident
     (the retired Host.tla's KeepMidArms) and the crash-abort shape of the
     2026-08-15 alarm() path, one defect with two doors. *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Lanes, MaxCrashes

VARIABLES owed, armed, inPass, queue, answers, crashes

vars == <<owed, armed, inPass, queue, answers, crashes>>

TypeOK ==
  /\ owed \in [Lanes -> BOOLEAN]
  /\ armed \in BOOLEAN
  /\ inPass \in BOOLEAN
  /\ queue \subseteq Lanes
  /\ answers \in [Lanes -> BOOLEAN]
  /\ crashes \in 0..MaxCrashes

Init ==
  /\ owed = [l \in Lanes |-> FALSE]
  /\ armed = FALSE
  /\ inPass = FALSE
  /\ queue = {}
  /\ answers = [l \in Lanes |-> FALSE]
  /\ crashes = 0

(* Work arrives on a lane, any time, mid-pass included. The deliver
   contract: every arrival arms. *)
Arrive(l) ==
  /\ ~owed[l]
  /\ owed' = [owed EXCEPT ![l] = TRUE]
  /\ armed' = TRUE
  /\ UNCHANGED <<inPass, queue, answers, crashes>>

(* The alarm fires: consume the arm, open a pass over every lane. *)
Fire ==
  /\ armed
  /\ ~inPass
  /\ armed' = FALSE
  /\ inPass' = TRUE
  /\ queue' = Lanes
  /\ UNCHANGED <<owed, answers, crashes>>

(* A visit serves its lane: owed work discharges, and the lane answers
   the pass "quiet as of my visit". *)
VisitOk(l) ==
  /\ inPass
  /\ l \in queue
  /\ owed' = [owed EXCEPT ![l] = FALSE]
  /\ answers' = [answers EXCEPT ![l] = FALSE]
  /\ queue' = queue \ {l}
  /\ UNCHANGED <<armed, inPass, crashes>>

(* A visit crashes: the lane's owed derivation is untouched (REDRIVE:
   the log lost nothing, the derivation re-raises the work), and the
   lane contributes no answer to the pass. *)
VisitCrash(l) ==
  /\ inPass
  /\ l \in queue
  /\ crashes < MaxCrashes
  /\ answers' = [answers EXCEPT ![l] = FALSE]
  /\ queue' = queue \ {l}
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<owed, armed, inPass>>

(* The contract re-arm: live derivations folded in, mid-pass arms kept. *)
ReArm ==
  /\ inPass
  /\ queue = {}
  /\ inPass' = FALSE
  /\ armed' = (armed \/ \E l \in Lanes: owed[l])
  /\ UNCHANGED <<owed, queue, answers, crashes>>

(* The defective re-arm: trust only the pass's own answers. *)
ReArmDrop ==
  /\ inPass
  /\ queue = {}
  /\ inPass' = FALSE
  /\ armed' = (\E l \in Lanes: answers[l])
  /\ UNCHANGED <<owed, queue, answers, crashes>>

ArriveAny == \E l \in Lanes: Arrive(l)
VisitAny  == \E l \in Lanes: VisitOk(l) \/ VisitCrash(l)

Next     == ArriveAny \/ Fire \/ VisitAny \/ ReArm
NextDrop == ArriveAny \/ Fire \/ VisitAny \/ ReArmDrop

Spec     == Init /\ [][Next]_vars
DropSpec == Init /\ [][NextDrop]_vars

(* Liveness: fair firing and pass-closing; visits strongly fair (a
   lane's visit is enabled once per pass, intermittently, so weak
   fairness is not enough). Crashes are bounded, so retries converge. *)
LiveSpec ==
  /\ Spec
  /\ WF_vars(Fire)
  /\ WF_vars(ReArm)
  /\ \A l \in Lanes: SF_vars(VisitOk(l))

-----------------------------------------------------------------------
(* The debts. *)

(* ACCOUNTING: owed work always has a wake coming. *)
Accounting == (\E l \in Lanes: owed[l]) => (armed \/ inPass)

(* SERVICE (under LiveSpec): every owed lane is eventually served. *)
EventuallyServed == \A l \in Lanes: [](owed[l] => <>(~owed[l]))

=======================================================================
