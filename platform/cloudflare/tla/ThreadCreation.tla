------------------------- MODULE ThreadCreation -------------------------
(* ThreadCreation models one child crossing the Actor DO supervisor log and Thread DO log boundary. The Actor DO projects its tree from ThreadCreated, which requires durable acceptance by the child. *)

EXTENDS FiniteSets, TLC

CONSTANTS Calls, Threads, Target, None

ASSUME Target \in [Calls -> Threads]
ASSUME None \notin Calls
ASSUME \A left \in Calls, right \in Calls: Target[left] = Target[right] => left = right

ModelCalls == {"first", "second"}
ModelThreads == {"left", "right"}
ModelTarget == [call \in ModelCalls |->
  CASE call = "first" -> "left"
    [] OTHER -> "right"]

VARIABLES staged, requested, accepted, created, owner

vars == <<staged, requested, accepted, created, owner>>

TypeOK ==
  /\ staged \subseteq Calls
  /\ requested \subseteq Calls
  /\ accepted \subseteq Calls
  /\ created \subseteq Threads
  /\ owner \in [Threads -> Calls \cup {None}]

Init ==
  /\ staged = {}
  /\ requested = {}
  /\ accepted = {}
  /\ created = {}
  /\ owner = [thread \in Threads |-> None]

(* Stage durably stores ThreadCreated and the initial delivery in the child log without starting it. *)
Stage(call) ==
  /\ call \notin staged
  /\ staged' = staged \cup {call}
  /\ UNCHANGED <<requested, accepted, created, owner>>

(* Request records ThreadRequested in the Actor DO after the child payload is durable. *)
Request(call) ==
  LET thread == Target[call]
  IN
    /\ call \in staged
    /\ call \notin requested
    /\ requested' = requested \cup {call}
    /\ owner' = [owner EXCEPT ![thread] = call]
    /\ UNCHANGED <<staged, accepted, created>>

(* Accept arms child recovery before the supervisor records creation. *)
Accept(call) ==
  /\ call \in requested
  /\ call \notin accepted
  /\ accepted' = accepted \cup {call}
  /\ UNCHANGED <<staged, requested, created, owner>>

(* Create records ThreadCreated in the Actor DO and exposes the child in its tree. *)
Create(call) ==
  LET thread == Target[call]
  IN
    /\ call \in accepted
    /\ thread \notin created
    /\ created' = created \cup {thread}
    /\ UNCHANGED <<staged, requested, accepted, owner>>

Next ==
  \/ \E call \in Calls: Stage(call)
  \/ \E call \in Calls: Request(call)
  \/ \E call \in Calls: Accept(call)
  \/ \E call \in Calls: Create(call)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ \A call \in Calls: WF_vars(Accept(call))
  /\ \A call \in Calls: WF_vars(Create(call))

(* CurrentCreate exposes a child from ThreadCreated before the Thread DO accepts recovery ownership. *)
CurrentCreate(call) ==
  LET thread == Target[call]
  IN
    /\ call \in requested
    /\ thread \notin created
    /\ created' = created \cup {thread}
    /\ UNCHANGED <<staged, requested, accepted, owner>>

CurrentNext ==
  \/ \E call \in Calls: Stage(call)
  \/ \E call \in Calls: Request(call)
  \/ \E call \in Calls: CurrentCreate(call)
  \/ \E call \in Calls: Accept(call)

CurrentSpec == Init /\ [][CurrentNext]_vars

(* CreatedHasAccepted states that every actor-visible child has durable recovery ownership. *)
CreatedHasAccepted ==
  \A thread \in created:
    owner[thread] \in accepted /\ Target[owner[thread]] = thread

(* AcceptedHasRequest states that every accepted child belongs to a durable actor request. *)
AcceptedHasRequest ==
  \A call \in accepted: call \in requested /\ owner[Target[call]] = call

(* RequestedHasStage states that the child payload is durable before the actor owns the request. *)
RequestedHasStage == requested \subseteq staged

(* AllRequestsCreated states that the Actor DO alarm eventually completes every durable request. *)
AllRequestsCreated ==
  \A call \in Calls: call \in requested ~> Target[call] \in created

=============================================================================
