------------------------------ MODULE Method ------------------------------
(* Method models state reports derived from a declared method and the link accepted with its call. A response reads no destination outside that link. *)

EXTENDS FiniteSets, TLC

CONSTANTS Addresses, Calls, Methods, CallLink, CallMethod

Links == Addresses \X Addresses

ASSUME CallLink \in [Calls -> Links]
ASSUME CallMethod \in [Calls -> Methods]

Source(link) == link[1]
Target(link) == link[2]
Reverse(link) == <<Target(link), Source(link)>>

ModelAddresses == {"telegram", "support", "reviewer"}
ModelCalls == {"telegram-message", "parent-brief"}
ModelMethods == {"message", "review"}
ModelCallLink == [call \in ModelCalls |->
  CASE call = "telegram-message" -> <<"telegram", "support">>
    [] OTHER -> <<"support", "reviewer">>]
ModelCallMethod == [call \in ModelCalls |->
  CASE call = "telegram-message" -> "message"
    [] OTHER -> "review"]

VARIABLES accepted, blocked, terminal, responded, delivered, responses

vars == <<accepted, blocked, terminal, responded, delivered, responses>>

TypeOK ==
  /\ accepted \subseteq Calls
  /\ blocked \subseteq accepted
  /\ terminal \subseteq accepted
  /\ responded \subseteq blocked \cup terminal
  /\ delivered \subseteq responded
  /\ responses \subseteq Calls \X Methods \X Links

Init ==
  /\ accepted = {}
  /\ blocked = {}
  /\ terminal = {}
  /\ responded = {}
  /\ delivered = {}
  /\ responses = {}

Accept(call) ==
  /\ call \notin accepted
  /\ accepted' = accepted \cup {call}
  /\ UNCHANGED <<blocked, terminal, responded, delivered, responses>>

Block(call) ==
  /\ call \in accepted
  /\ call \notin blocked
  /\ call \notin terminal
  /\ blocked' = blocked \cup {call}
  /\ UNCHANGED <<accepted, terminal, responded, delivered, responses>>

Finish(call) ==
  /\ call \in accepted
  /\ call \notin terminal
  /\ terminal' = terminal \cup {call}
  /\ UNCHANGED <<accepted, blocked, responded, delivered, responses>>

Respond(call) ==
  /\ call \in blocked \cup terminal
  /\ call \notin responded
  /\ responded' = responded \cup {call}
  /\ responses' = responses \cup {<<call, CallMethod[call], Reverse(CallLink[call])>>}
  /\ UNCHANGED <<accepted, blocked, terminal, delivered>>

Deliver(call) ==
  /\ call \in responded
  /\ call \notin delivered
  /\ delivered' = delivered \cup {call}
  /\ UNCHANGED <<accepted, blocked, terminal, responded, responses>>

Next ==
  \/ \E call \in Calls: Accept(call)
  \/ \E call \in Calls: Block(call)
  \/ \E call \in Calls: Finish(call)
  \/ \E call \in Calls: Respond(call)
  \/ \E call \in Calls: Deliver(call)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ \A call \in Calls: WF_vars(Respond(call))
  /\ \A call \in Calls: WF_vars(Deliver(call))

ResponseReversesAcceptedLink ==
  \A response \in responses:
    response[3] = Reverse(CallLink[response[1]])

ResponseMatchesMethod ==
  \A response \in responses:
    response[2] = CallMethod[response[1]]

ResponseRequiresAcceptedCall ==
  responded \subseteq accepted /\ responded \subseteq blocked \cup terminal

ResponseReturnsToSource ==
  \A response \in responses:
    Target(response[3]) = Source(CallLink[response[1]])

AllReportableCallsRespond ==
  \A call \in Calls:
    call \in blocked \cup terminal ~> call \in delivered

HintRespond(call, method, target) ==
  /\ call \in blocked \cup terminal
  /\ call \notin responded
  /\ responded' = responded \cup {call}
  /\ responses' = responses \cup {<<call, method, <<Target(CallLink[call]), target>>>>}
  /\ UNCHANGED <<accepted, blocked, terminal, delivered>>

HintNext ==
  \/ \E call \in Calls: Accept(call)
  \/ \E call \in Calls: Block(call)
  \/ \E call \in Calls: Finish(call)
  \/ \E call \in Calls, method \in Methods, target \in Addresses: HintRespond(call, method, target)
  \/ \E call \in Calls: Deliver(call)

HintSpec == Init /\ [][HintNext]_vars

=============================================================================
