------------------------------ MODULE Method ------------------------------
(* Method models unary responses derived from a declared method and the link accepted with its call. Intermediate coordination is another call with its own identity. *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Addresses, Calls, Methods, CallLink, CallMethod

Links == Addresses \X Addresses

ASSUME CallLink \in [Calls -> Links]
ASSUME CallMethod \in [Calls -> Methods]

Source(link) == link[1]
Target(link) == link[2]
Reverse(link) == <<Target(link), Source(link)>>

ModelAddresses == {"parent", "child"}
ModelCalls == {"child-run", "budget-request"}
ModelMethods == {"message", "requestBudget"}
ModelCallLink == [call \in ModelCalls |->
  CASE call = "child-run" -> <<"parent", "child">>
    [] OTHER -> <<"child", "parent">>]
ModelCallMethod == [call \in ModelCalls |->
  CASE call = "child-run" -> "message"
    [] OTHER -> "requestBudget"]

VARIABLES requested, sent, accepted, terminal, failed, responded, delivered, responses

vars == <<requested, sent, accepted, terminal, failed, responded, delivered, responses>>

TypeOK ==
  /\ requested \subseteq Calls
  /\ sent \subseteq Calls
  /\ accepted \subseteq Calls
  /\ terminal \subseteq accepted
  /\ failed \subseteq terminal
  /\ responded \subseteq terminal
  /\ delivered \subseteq responded
  /\ responses \subseteq Calls \X Methods \X Links

Init ==
  /\ requested = {}
  /\ sent = {}
  /\ accepted = {}
  /\ terminal = {}
  /\ failed = {}
  /\ responded = {}
  /\ delivered = {}
  /\ responses = {}

Request(call) ==
  /\ call \notin requested
  /\ requested' = requested \cup {call}
  /\ UNCHANGED <<sent, accepted, terminal, failed, responded, delivered, responses>>

Send(call) ==
  /\ call \in requested
  /\ call \notin sent
  /\ sent' = sent \cup {call}
  /\ UNCHANGED <<requested, accepted, terminal, failed, responded, delivered, responses>>

Accept(call) ==
  /\ call \in sent
  /\ call \notin accepted
  /\ accepted' = accepted \cup {call}
  /\ UNCHANGED <<requested, sent, terminal, failed, responded, delivered, responses>>

Resolve(call) ==
  /\ call \in accepted
  /\ call \notin terminal
  /\ terminal' = terminal \cup {call}
  /\ \/ failed' = failed
     \/ failed' = failed \cup {call}
  /\ UNCHANGED <<requested, sent, accepted, responded, delivered, responses>>

Respond(call) ==
  /\ call \in terminal
  /\ call \notin responded
  /\ responded' = responded \cup {call}
  /\ responses' = responses \cup {<<call, CallMethod[call], Reverse(CallLink[call])>>}
  /\ UNCHANGED <<requested, sent, accepted, terminal, failed, delivered>>

Deliver(call) ==
  /\ call \in responded
  /\ call \notin delivered
  /\ delivered' = delivered \cup {call}
  /\ UNCHANGED <<requested, sent, accepted, terminal, failed, responded, responses>>

Next ==
  \/ \E call \in Calls: Request(call)
  \/ \E call \in Calls: Send(call)
  \/ \E call \in Calls: Accept(call)
  \/ \E call \in Calls: Resolve(call)
  \/ \E call \in Calls: Respond(call)
  \/ \E call \in Calls: Deliver(call)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ \A call \in Calls: WF_vars(Send(call))
  /\ \A call \in Calls: WF_vars(Accept(call))
  /\ \A call \in Calls: WF_vars(Resolve(call))
  /\ \A call \in Calls: WF_vars(Respond(call))
  /\ \A call \in Calls: WF_vars(Deliver(call))

ResponseReversesAcceptedLink ==
  \A response \in responses:
    response[3] = Reverse(CallLink[response[1]])

ResponseMatchesMethod ==
  \A response \in responses:
    response[2] = CallMethod[response[1]]

ResponseRequiresTerminalCall ==
  responded \subseteq accepted /\ responded \subseteq terminal

CallFollowsProtocol ==
  accepted \subseteq sent /\ sent \subseteq requested

AtMostOneResponsePerCall ==
  \A call \in Calls: Cardinality({response \in responses: response[1] = call}) <= 1

ResponseReturnsToSource ==
  \A response \in responses:
    Target(response[3]) = Source(CallLink[response[1]])

AllTerminalCallsRespond ==
  \A call \in Calls:
    call \in terminal ~> call \in delivered

AllRequestedCallsRespond ==
  \A call \in Calls:
    call \in requested ~> call \in delivered

HintRespond(call, method, target) ==
  /\ call \in terminal
  /\ call \notin responded
  /\ responded' = responded \cup {call}
  /\ responses' = responses \cup {<<call, method, <<Target(CallLink[call]), target>>>>}
  /\ UNCHANGED <<requested, sent, accepted, terminal, failed, delivered>>

HintNext ==
  \/ \E call \in Calls: Request(call)
  \/ \E call \in Calls: Send(call)
  \/ \E call \in Calls: Accept(call)
  \/ \E call \in Calls: Resolve(call)
  \/ \E call \in Calls, method \in Methods, target \in Addresses: HintRespond(call, method, target)
  \/ \E call \in Calls: Deliver(call)

HintSpec == Init /\ [][HintNext]_vars

=============================================================================
