------------------------ MODULE ComponentAdmission ------------------------
(* ComponentAdmission models proposal selection at two parent boundaries and serial admission commits (ComponentAdmission.cfg). *)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS Limit, MaxChanges, StaleCommit, ChildCommit, EarlyEffect
Calls == {"a", "b"}
Members(s) == {s[i]: i \in DOMAIN s}

VARIABLES log, used, allowed, pending, inner, selected, selectedAt,
          executed, changes
vars == <<log, used, allowed, pending, inner, selected, selectedAt,
          executed, changes>>

Admissions(history) == SelectSeq(history, LAMBDA e: e.kind = "admit")
Committed == {Admissions(log)[i].call: i \in DOMAIN Admissions(log)}
View == [used |-> used]

Init ==
  /\ log = <<>>
  /\ used = 0
  /\ allowed = Calls
  /\ pending = Calls
  /\ inner = {}
  /\ selected = {}
  /\ selectedAt = -1
  /\ executed = {}
  /\ changes = 0

(* Evaluate leaves child state unchanged and selects from the immediate child's proposals (SelectionBoundary). *)
Evaluate ==
  /\ inner' = pending \cap allowed
  /\ selected' = IF View.used < Limit THEN inner' ELSE {}
  /\ selectedAt' = Len(log)
  /\ UNCHANGED <<log, used, allowed, pending, executed, changes>>

ChangePermission(call) ==
  /\ changes < MaxChanges
  /\ allowed' = IF call \in allowed THEN allowed \ {call} ELSE allowed \cup {call}
  /\ log' = Append(log, [kind |-> "permission", call |-> call, permitted |-> TRUE, before |-> used])
  /\ changes' = changes + 1
  /\ UNCHANGED <<used, pending, inner, selected, selectedAt, executed>>

(* Commit records one admitted call before another selection can use its allowance (AdmittedWithinLimit). *)
Commit(call) ==
  /\ call \in pending
  /\ (ChildCommit \/ (call \in selected /\ (StaleCommit \/ selectedAt = Len(log))))
  /\ log' = Append(log, [kind |-> "admit", call |-> call, permitted |-> call \in allowed, before |-> used])
  /\ used' = used + 1
  /\ pending' = pending \ {call}
  /\ UNCHANGED <<allowed, inner, selected, selectedAt, executed, changes>>

Execute(call) ==
  /\ call \notin executed
  /\ (call \in Committed \/ (EarlyEffect /\ call \in pending))
  /\ executed' = executed \cup {call}
  /\ UNCHANGED <<log, used, allowed, pending, inner, selected, selectedAt, changes>>

Next == \/ Evaluate
        \/ \E call \in Calls: ChangePermission(call) \/ Commit(call) \/ Execute(call)
Spec == Init /\ [][Next]_vars

TypeOK == /\ used \in 0..Cardinality(Calls)
          /\ allowed \subseteq Calls
          /\ pending \subseteq Calls
          /\ inner \subseteq Calls
          /\ selected \subseteq Calls
          /\ executed \subseteq Calls
          /\ selectedAt \in (-1)..Len(log)
          /\ changes \in 0..MaxChanges
SelectionBoundary == selected \subseteq inner
ReplayObservation == View.used = Len(Admissions(log))
AdmittedWithinLimit == \A i \in DOMAIN Admissions(log): Admissions(log)[i].before < Limit
PermissionAtCommit == \A i \in DOMAIN Admissions(log): Admissions(log)[i].permitted
NoExecutionBeforeAdmission == executed \subseteq Committed
AdmissionIdentity == Cardinality(Committed) = Len(Admissions(log))

=============================================================================
