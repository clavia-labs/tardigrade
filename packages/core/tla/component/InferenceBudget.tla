--------------------------- MODULE InferenceBudget ---------------------------
EXTENDS Naturals, Sequences

\* InferenceBudget checks retry admission from settled attempt evidence and recorded policy.

CONSTANTS Bound, MaxCost, Turns, Fault
ASSUME /\ Bound \in Nat
       /\ MaxCost \in Nat
       /\ Turns \in Nat \ {0}
       /\ Fault \in {"none", "false-zero", "admit-at-bound", "recovery-drift", "missing-policy"}

Policies == {"block", "admit"}
Requests == {"default", "block", "admit"}
EffectivePolicy(requested) == IF requested = "default" THEN "block" ELSE requested

VARIABLES spendLog, projectedKnown, projectedUnknown, pending, phase,
          admissions, lastAdmissionSafe

vars == <<spendLog, projectedKnown, projectedUnknown, pending, phase,
          admissions, lastAdmissionSafe>>

RECURSIVE KnownSpend(_)
KnownSpend(events) ==
  IF Len(events) = 0
  THEN 0
  ELSE KnownSpend(SubSeq(events, 1, Len(events) - 1))
       + IF events[Len(events)].known THEN events[Len(events)].cost ELSE 0

HasUnknown(events) == \E i \in 1..Len(events) : ~events[i].known
ActualCanAdmit(events, policy) ==
  IF HasUnknown(events) THEN policy = "admit" ELSE KnownSpend(events) < Bound
ProjectedCanAdmit(policy) ==
  IF projectedUnknown
  THEN policy = "admit"
  ELSE IF Fault = "admit-at-bound" THEN projectedKnown <= Bound ELSE projectedKnown < Bound

InitialAdmission ==
  [requested |-> "default", policy |-> "block", known |-> 0, unknown |-> FALSE, events |-> <<>>]

Init ==
  /\ spendLog = <<>>
  /\ projectedKnown = 0
  /\ projectedUnknown = FALSE
  /\ pending = TRUE
  /\ phase = "running"
  /\ admissions = <<InitialAdmission>>
  /\ lastAdmissionSafe = TRUE

FinishKnown(cost, succeeded, terminal) ==
  /\ phase = "running" /\ pending /\ Len(spendLog) < Turns
  /\ spendLog' = Append(spendLog, [known |-> TRUE, cost |-> cost, succeeded |-> succeeded])
  /\ projectedKnown' = projectedKnown + cost
  /\ projectedUnknown' = projectedUnknown
  /\ pending' = FALSE
  /\ phase' = IF succeeded /\ terminal THEN "complete" ELSE phase
  /\ UNCHANGED <<admissions, lastAdmissionSafe>>

FinishUnknown(succeeded, terminal) ==
  /\ phase = "running" /\ pending /\ Len(spendLog) < Turns
  /\ spendLog' = Append(spendLog, [known |-> FALSE, cost |-> 0, succeeded |-> succeeded])
  /\ projectedKnown' = projectedKnown
  /\ projectedUnknown' = IF Fault = "false-zero" THEN FALSE ELSE TRUE
  /\ pending' = FALSE
  /\ phase' = IF succeeded /\ terminal THEN "complete" ELSE phase
  /\ UNCHANGED <<admissions, lastAdmissionSafe>>

AdmitNext(requested) ==
  LET policy == EffectivePolicy(requested)
      recordedPolicy == IF Fault = "missing-policy" THEN "missing" ELSE policy
  IN /\ phase = "running" /\ ~pending /\ Len(spendLog) < Turns
     /\ ProjectedCanAdmit(policy)
     /\ pending' = TRUE
     /\ admissions' = Append(admissions,
          [requested |-> requested, policy |-> recordedPolicy,
           known |-> projectedKnown, unknown |-> projectedUnknown, events |-> spendLog])
     /\ lastAdmissionSafe' = ActualCanAdmit(spendLog, policy)
     /\ UNCHANGED <<spendLog, projectedKnown, projectedUnknown, phase>>

Rebuild ==
  /\ projectedKnown' = IF Fault = "recovery-drift" /\ Len(spendLog) > 0
                       THEN 0 ELSE KnownSpend(spendLog)
  /\ projectedUnknown' = HasUnknown(spendLog)
  /\ UNCHANGED <<spendLog, pending, phase, admissions, lastAdmissionSafe>>

Next ==
  \/ \E cost \in 0..MaxCost, succeeded \in BOOLEAN, terminal \in BOOLEAN :
       FinishKnown(cost, succeeded, terminal)
  \/ \E succeeded \in BOOLEAN, terminal \in BOOLEAN : FinishUnknown(succeeded, terminal)
  \/ \E requested \in Requests : AdmitNext(requested)
  \/ Rebuild

Spec == Init /\ [][Next]_vars

UnknownNeverZero == HasUnknown(spendLog) => projectedUnknown
ProjectionFromLog == projectedKnown = KnownSpend(spendLog) /\ projectedUnknown = HasUnknown(spendLog)
NextCallWithinBudget == lastAdmissionSafe
AdmissionEvidenceRecorded ==
  \A i \in 1..Len(admissions) :
    /\ admissions[i].policy = EffectivePolicy(admissions[i].requested)
    /\ admissions[i].known = KnownSpend(admissions[i].events)
    /\ admissions[i].unknown = HasUnknown(admissions[i].events)
DefaultUnknownBlocks == ~ProjectedCanAdmit(EffectivePolicy("default"))
                            <=> (projectedUnknown \/ projectedKnown >= Bound)
UnknownAdmitIgnoresKnownSubtotal == projectedUnknown => ProjectedCanAdmit(EffectivePolicy("admit"))
KnownZeroFailurePermitsRetry ==
  Len(spendLog) > 0 /\ ~spendLog[Len(spendLog)].succeeded
    /\ spendLog[Len(spendLog)].known /\ spendLog[Len(spendLog)].cost = 0
    /\ KnownSpend(spendLog) < Bound /\ ~HasUnknown(spendLog)
  => ProjectedCanAdmit(EffectivePolicy("default"))
UnknownFailureNeedsPolicy ==
  Len(spendLog) > 0 /\ ~spendLog[Len(spendLog)].succeeded /\ ~spendLog[Len(spendLog)].known
  => /\ ~ProjectedCanAdmit(EffectivePolicy("default"))
     /\ ProjectedCanAdmit(EffectivePolicy("admit"))
TerminalAnswerCompletes == phase = "complete" => ~pending
=============================================================================
