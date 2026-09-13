--------------------------- MODULE InferenceBudget ---------------------------
EXTENDS Naturals, Sequences

CONSTANTS Bound, MaxCost, Turns, Fault
ASSUME /\ Bound \in Nat
       /\ MaxCost \in Nat
       /\ Turns \in Nat \ {0}
       /\ Fault \in {"none", "false-zero", "admit-at-bound", "recovery-drift"}

RECURSIVE KnownSpend(_)
KnownSpend(events) ==
  IF Len(events) = 0
  THEN 0
  ELSE KnownSpend(SubSeq(events, 1, Len(events) - 1))
       + IF events[Len(events)].known THEN events[Len(events)].cost ELSE 0

HasUnknown(events) == \E i \in 1..Len(events) : ~events[i].known
CanAdmit(events) == ~HasUnknown(events) /\ KnownSpend(events) < Bound

VARIABLES spendLog, projectedKnown, projectedUnknown, pending, phase,
          admissions, lastAdmissionSafe

vars == <<spendLog, projectedKnown, projectedUnknown, pending, phase,
          admissions, lastAdmissionSafe>>

Init ==
  /\ spendLog = <<>>
  /\ projectedKnown = 0
  /\ projectedUnknown = FALSE
  /\ pending = TRUE
  /\ phase = "running"
  /\ admissions = 1
  /\ lastAdmissionSafe = TRUE

FinishKnown(cost, terminal) ==
  /\ phase = "running" /\ pending /\ Len(spendLog) < Turns
  /\ spendLog' = Append(spendLog, [known |-> TRUE, cost |-> cost])
  /\ projectedKnown' = projectedKnown + cost
  /\ projectedUnknown' = projectedUnknown
  /\ pending' = FALSE
  /\ phase' = IF terminal THEN "complete" ELSE phase
  /\ UNCHANGED <<admissions, lastAdmissionSafe>>

FinishUnknown(terminal) ==
  /\ phase = "running" /\ pending /\ Len(spendLog) < Turns
  /\ spendLog' = Append(spendLog, [known |-> FALSE, cost |-> 0])
  /\ projectedKnown' = projectedKnown
  /\ projectedUnknown' = IF Fault = "false-zero" THEN FALSE ELSE TRUE
  /\ pending' = FALSE
  /\ phase' = IF terminal THEN "complete" ELSE phase
  /\ UNCHANGED <<admissions, lastAdmissionSafe>>

AdmitNext ==
  LET projectedAdmission == ~projectedUnknown
                            /\ IF Fault = "admit-at-bound"
                               THEN projectedKnown <= Bound
                               ELSE projectedKnown < Bound
  IN /\ phase = "running" /\ ~pending /\ Len(spendLog) < Turns
     /\ projectedAdmission
     /\ pending' = TRUE
     /\ admissions' = admissions + 1
     /\ lastAdmissionSafe' = CanAdmit(spendLog)
     /\ UNCHANGED <<spendLog, projectedKnown, projectedUnknown, phase>>

Rebuild ==
  /\ projectedKnown' = IF Fault = "recovery-drift" /\ Len(spendLog) > 0
                       THEN 0 ELSE KnownSpend(spendLog)
  /\ projectedUnknown' = HasUnknown(spendLog)
  /\ UNCHANGED <<spendLog, pending, phase, admissions, lastAdmissionSafe>>

Next ==
  \/ \E cost \in 0..MaxCost, terminal \in BOOLEAN : FinishKnown(cost, terminal)
  \/ \E terminal \in BOOLEAN : FinishUnknown(terminal)
  \/ AdmitNext
  \/ Rebuild

Spec == Init /\ [][Next]_vars

UnknownNeverZero == HasUnknown(spendLog) => projectedUnknown
ProjectionFromLog == projectedKnown = KnownSpend(spendLog) /\ projectedUnknown = HasUnknown(spendLog)
NextCallWithinBudget == lastAdmissionSafe
TerminalAnswerCompletes == phase = "complete" => ~pending
=============================================================================
