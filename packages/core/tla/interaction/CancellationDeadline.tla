---------------------- MODULE CancellationDeadline ----------------------
(* CancellationDeadline models bounded settlement when a child never acknowledges. *)

EXTENDS Naturals, TLC

CONSTANT CancellationTimeout

ASSUME CancellationTimeout \in Nat \ {0}

VARIABLES phase, elapsed, child

vars == <<phase, elapsed, child>>

Init ==
  /\ phase = "requested"
  /\ elapsed = 0
  /\ child = "pending"

AcknowledgeChild ==
  /\ phase = "requested"
  /\ child = "pending"
  /\ child' = "acknowledged"
  /\ UNCHANGED <<phase, elapsed>>

AdvanceDeadline ==
  /\ phase = "requested"
  /\ child = "pending"
  /\ elapsed < CancellationTimeout
  /\ elapsed' = elapsed + 1
  /\ child' = IF elapsed' = CancellationTimeout THEN "timed-out" ELSE child
  /\ UNCHANGED phase

SettleCancellation ==
  /\ phase = "requested"
  /\ child \in {"acknowledged", "timed-out"}
  /\ phase' = "cancelled"
  /\ UNCHANGED <<elapsed, child>>

Next == AcknowledgeChild \/ AdvanceDeadline \/ SettleCancellation

Spec ==
  Init /\ [][Next]_vars
    /\ WF_vars(AdvanceDeadline)
    /\ WF_vars(SettleCancellation)

TypeOK ==
  /\ phase \in {"requested", "cancelled"}
  /\ elapsed \in 0..CancellationTimeout
  /\ child \in {"pending", "acknowledged", "timed-out"}

DeadlineDischargesChild ==
  elapsed = CancellationTimeout => child # "pending"

CancellationSettles ==
  (phase = "requested") ~> (phase = "cancelled")

===========================================================================
