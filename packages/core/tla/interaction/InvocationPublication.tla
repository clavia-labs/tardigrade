---------------------- MODULE InvocationPublication ----------------------
(* InvocationPublication models durable ownership before a child invocation becomes externally visible. *)

EXTENDS FiniteSets, TLC

CONSTANTS Links, Parents

ModelLinks == {<<"p1", "c1">>}
ModelParents == {"p1"}

ASSUME IsFiniteSet(Links)
ASSUME IsFiniteSet(Parents)
ASSUME Links \subseteq Parents \X STRING

VARIABLES planned, published, cancellationRequests, cancellations, settled

vars == <<planned, published, cancellationRequests, cancellations, settled>>

ChildrenOf(relation, parent) == {link \in relation : link[1] = parent}

TypeOK ==
  /\ planned \subseteq Links
  /\ published \subseteq Links
  /\ cancellationRequests \subseteq Parents
  /\ cancellations \subseteq Links
  /\ settled \subseteq Parents

Init ==
  /\ planned = {}
  /\ published = {}
  /\ cancellationRequests = {}
  /\ cancellations = {}
  /\ settled = {}

Plan(link) ==
  /\ link \in Links \ planned
  /\ link[1] \notin cancellationRequests
  /\ planned' = planned \cup {link}
  /\ UNCHANGED <<published, cancellationRequests, cancellations, settled>>

Publish(link) ==
  /\ link \in planned \ published
  /\ link[1] \notin cancellationRequests
  /\ published' = published \cup {link}
  /\ UNCHANGED <<planned, cancellationRequests, cancellations, settled>>

RequestCancellation(parent) ==
  /\ parent \in Parents \ cancellationRequests
  /\ cancellationRequests' = cancellationRequests \cup {parent}
  /\ UNCHANGED <<planned, published, cancellations, settled>>

CancelChild(link) ==
  /\ link \in ChildrenOf(planned, link[1])
  /\ link[1] \in cancellationRequests
  /\ link \notin cancellations
  /\ cancellations' = cancellations \cup {link}
  /\ UNCHANGED <<planned, published, cancellationRequests, settled>>

Settle(parent) ==
  /\ parent \in cancellationRequests \ settled
  /\ ChildrenOf(planned, parent) \subseteq cancellations
  /\ settled' = settled \cup {parent}
  /\ UNCHANGED <<planned, published, cancellationRequests, cancellations>>

PlanSome == \E link \in Links : Plan(link)
PublishSome == \E link \in Links : Publish(link)
RequestSome == \E parent \in Parents : RequestCancellation(parent)
CancelSome == \E link \in Links : CancelChild(link)
SettleSome == \E parent \in Parents : Settle(parent)

Next == PlanSome \/ PublishSome \/ RequestSome \/ CancelSome \/ SettleSome
Spec == Init /\ [][Next]_vars

(* PublishBeforePlan models an external send that precedes its durable ownership record. *)
PublishBeforePlan(link) ==
  /\ link \in Links \ published
  /\ link[1] \notin cancellationRequests
  /\ published' = published \cup {link}
  /\ UNCHANGED <<planned, cancellationRequests, cancellations, settled>>

NextPublishBeforePlan ==
  PlanSome \/ PublishSome \/ RequestSome \/ CancelSome \/ SettleSome \/
    \E link \in Links : PublishBeforePlan(link)
SpecPublishBeforePlan == Init /\ [][NextPublishBeforePlan]_vars

---------------------------------------------------------------------------
PublishedChildrenOwned == published \subseteq planned

NoOrphanAtSettlement ==
  \A parent \in settled : ChildrenOf(published, parent) \subseteq cancellations

===========================================================================
