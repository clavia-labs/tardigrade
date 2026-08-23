------------------------------ MODULE Reply ------------------------------
(* Reply models terminal delivery derived from the link accepted with an inbound message. Reply reads no destination outside that link, so actor and provider replies follow the same reversal rule. *)

EXTENDS FiniteSets, TLC

CONSTANTS Addresses, Requests, RequestLink, TerminalReports

Links == Addresses \X Addresses

ASSUME RequestLink \in [Requests -> Links]
ASSUME TerminalReports \subseteq Requests

Source(link) == link[1]
Target(link) == link[2]
Reverse(link) == <<Target(link), Source(link)>>

ModelAddresses == {"telegram", "support", "reviewer"}
ModelRequests == {"telegram-message", "parent-brief", "terminal-report"}
ModelRequestLink == [request \in ModelRequests |->
  CASE request = "telegram-message" -> <<"telegram", "support">>
    [] request = "parent-brief" -> <<"support", "reviewer">>
    [] OTHER -> <<"reviewer", "support">>]
ModelTerminalReports == {"terminal-report"}

VARIABLES accepted, finished, replied, delivered, replyLinks

vars == <<accepted, finished, replied, delivered, replyLinks>>

TypeOK ==
  /\ accepted \subseteq Requests
  /\ finished \subseteq accepted
  /\ replied \subseteq finished
  /\ delivered \subseteq replied
  /\ replyLinks \subseteq Requests \X Links

Init ==
  /\ accepted = {}
  /\ finished = {}
  /\ replied = {}
  /\ delivered = {}
  /\ replyLinks = {}

(* Accept records the inbound link beside the request. *)
Accept(request) ==
  /\ request \notin accepted
  /\ accepted' = accepted \cup {request}
  /\ UNCHANGED <<finished, replied, delivered, replyLinks>>

(* Finish records the terminal result of an accepted request. *)
Finish(request) ==
  /\ request \in accepted
  /\ request \notin finished
  /\ finished' = finished \cup {request}
  /\ UNCHANGED <<accepted, replied, delivered, replyLinks>>

(* Reply derives the return link by reversing the accepted link. Terminal reports settle without creating another report. *)
Reply(request) ==
  /\ request \in finished
  /\ request \notin replied
  /\ request \notin TerminalReports
  /\ replied' = replied \cup {request}
  /\ replyLinks' = replyLinks \cup {<<request, Reverse(RequestLink[request])>>}
  /\ UNCHANGED <<accepted, finished, delivered>>

(* DeliverReply records the reply at its derived destination. Link.tla, AtMostOnce covers transport retries. *)
DeliverReply(request) ==
  /\ request \in replied
  /\ request \notin delivered
  /\ delivered' = delivered \cup {request}
  /\ UNCHANGED <<accepted, finished, replied, replyLinks>>

Next ==
  \/ \E request \in Requests: Accept(request)
  \/ \E request \in Requests: Finish(request)
  \/ \E request \in Requests: Reply(request)
  \/ \E request \in Requests: DeliverReply(request)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ \A request \in Requests \ TerminalReports: WF_vars(Reply(request))
  /\ \A request \in Requests \ TerminalReports: WF_vars(DeliverReply(request))

(* ReplyReversesAcceptedLink states that every reply link is derived from its accepted inbound link. *)
ReplyReversesAcceptedLink ==
  \A entry \in replyLinks:
    entry[2] = Reverse(RequestLink[entry[1]])

(* ReplyRequiresAcceptedInbound states that no reply exists without an accepted and finished request. *)
ReplyRequiresAcceptedInbound == replied \subseteq accepted /\ replied \subseteq finished

(* ReplyReturnsToSource states that each reply target is the inbound source. *)
ReplyReturnsToSource ==
  \A entry \in replyLinks:
    Target(entry[2]) = Source(RequestLink[entry[1]])

(* NoReplyChain states that a terminal report cannot create another terminal report. *)
NoReplyChain == replied \cap TerminalReports = {}

(* AllFinishedReply states that every finished non-report request eventually reaches its reply destination. *)
AllFinishedReply ==
  \A request \in Requests \ TerminalReports:
    request \in finished ~> request \in delivered

(* HintReply models an independently supplied reply target. The target can disagree with the accepted inbound source. *)
HintReply(request, target) ==
  /\ request \in finished
  /\ request \notin replied
  /\ request \notin TerminalReports
  /\ replied' = replied \cup {request}
  /\ replyLinks' = replyLinks \cup {<<request, <<Target(RequestLink[request]), target>>>>}
  /\ UNCHANGED <<accepted, finished, delivered>>

HintNext ==
  \/ \E request \in Requests: Accept(request)
  \/ \E request \in Requests: Finish(request)
  \/ \E request \in Requests, target \in Addresses: HintReply(request, target)
  \/ \E request \in Requests: DeliverReply(request)

HintSpec == Init /\ [][HintNext]_vars

=============================================================================
