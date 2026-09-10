---------------------------- MODULE ExternalReply ----------------------------
EXTENDS FiniteSets, Naturals

CONSTANTS ReplyIds, WaitingIds, PackageCallId, Fault
ASSUME /\ ReplyIds # {} /\ WaitingIds \subseteq ReplyIds
       /\ Fault \in {"none", "collapse", "duplicate-head", "wake-any", "new-turn", "method-terminal", "new-package"}

VARIABLES submitted, keys, recorded, head, wakes, turns, terminals, callId, restarted
vars == <<submitted, keys, recorded, head, wakes, turns, terminals, callId, restarted>>

ReplyKey(id) == IF Fault = "collapse" THEN "external-reply" ELSE <<"external-reply", id>>

Init == /\ submitted = {} /\ keys = {} /\ recorded = {} /\ head = 0
        /\ wakes = {} /\ turns = 0 /\ terminals = 0
        /\ callId = PackageCallId /\ restarted = FALSE

Append(id) ==
  /\ id \in ReplyIds /\ id \notin submitted
  /\ submitted' = submitted \cup {id}
  /\ LET fresh == ReplyKey(id) \notin keys
     IN /\ keys' = keys \cup {ReplyKey(id)}
        /\ recorded' = IF fresh THEN recorded \cup {id} ELSE recorded
        /\ head' = IF fresh \/ Fault = "duplicate-head" THEN head + 1 ELSE head
  /\ wakes' = IF Fault = "wake-any" THEN WaitingIds ELSE wakes \cup (WaitingIds \cap {id})
  /\ turns' = turns + IF Fault = "new-turn" THEN 1 ELSE 0
  /\ terminals' = terminals + IF Fault = "method-terminal" THEN 1 ELSE 0
  /\ UNCHANGED <<callId, restarted>>

Redeliver(id) ==
  /\ id \in submitted
  /\ head' = IF Fault = "duplicate-head" THEN head + 1 ELSE head
  /\ UNCHANGED <<submitted, keys, recorded, wakes, turns, terminals, callId, restarted>>

Restart ==
  /\ ~restarted
  /\ restarted' = TRUE
  /\ callId' = IF Fault = "new-package" THEN <<PackageCallId, "retry">> ELSE callId
  /\ UNCHANGED <<submitted, keys, recorded, head, wakes, turns, terminals>>

Next == (\E id \in ReplyIds : Append(id) \/ Redeliver(id)) \/ Restart
Spec == Init /\ [][Next]_vars

TypeOK == /\ submitted \subseteq ReplyIds /\ recorded \subseteq ReplyIds
          /\ wakes \subseteq WaitingIds /\ head \in Nat
          /\ turns \in Nat /\ terminals \in Nat /\ restarted \in BOOLEAN
DistinctRepliesPreserved == submitted = recorded
DuplicateIdKeepsHead == head = Cardinality(recorded)
WakesOnlyMatchingWait == wakes = WaitingIds \cap recorded
SilentReply == turns = 0 /\ terminals = 0
StablePackageIdentity == callId = PackageCallId

=============================================================================
