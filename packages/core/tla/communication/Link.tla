------------------------------ MODULE Link ------------------------------
(* Link models durable delivery through a directed source and target pair. Addresses and placements are abstract so the same actions cover local append, remote RPC, and provider ingress. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Addresses, Places, Links, Messages, LinkOf, InitialPlacement, MaxAttempts, None

ASSUME Links \subseteq Addresses \X Addresses
ASSUME LinkOf \in [Messages -> Links]
ASSUME InitialPlacement \in [Addresses -> Places]
ASSUME None \notin Places
ASSUME MaxAttempts \in Nat /\ MaxAttempts > 0

Source(link) == link[1]
Target(link) == link[2]

ModelAddresses == {"telegram", "support", "reviewer"}
ModelPlaces == {"edgeA", "edgeB"}
ModelLinks == {<<"telegram", "support">>, <<"support", "reviewer">>}
ModelMessages == {"m1", "m2"}
ModelLinkOf == [message \in ModelMessages |->
  IF message = "m1" THEN <<"telegram", "support">> ELSE <<"support", "reviewer">>]
ModelPlacement == [address \in ModelAddresses |->
  IF address = "reviewer" THEN "edgeB" ELSE "edgeA"]

TinyAddresses == {"telegram", "support"}
TinyPlaces == {"edgeA", "edgeB"}
TinyLinks == {<<"telegram", "support">>}
TinyMessages == {"m1"}
TinyLinkOf == [message \in TinyMessages |-> <<"telegram", "support">>]
TinyPlacement == [address \in TinyAddresses |-> "edgeA"]

VARIABLES sent, pending, committed, logs, placement, resolved, attempts

vars == <<sent, pending, committed, logs, placement, resolved, attempts>>

Values(sequence) == {sequence[index] : index \in DOMAIN sequence}
Logged == UNION {Values(logs[address]) : address \in Addresses}

TypeOK ==
  /\ sent \subseteq Messages
  /\ pending \subseteq sent
  /\ committed \subseteq sent
  /\ logs \in [Addresses -> Seq(Messages)]
  /\ placement \in [Addresses -> Places]
  /\ resolved \in [Messages -> Places \cup {None}]
  /\ attempts \in [Messages -> 0..MaxAttempts]

Init ==
  /\ sent = {}
  /\ pending = {}
  /\ committed = {}
  /\ logs = [address \in Addresses |-> <<>>]
  /\ placement = InitialPlacement
  /\ resolved = [message \in Messages |-> None]
  /\ attempts = [message \in Messages |-> 0]

(* Send makes one named delivery pending without resolving its target placement. *)
Send(message) ==
  /\ message \notin sent
  /\ sent' = sent \cup {message}
  /\ pending' = pending \cup {message}
  /\ UNCHANGED <<committed, logs, placement, resolved, attempts>>

(* Resolve models Router reading the target's current transport coordinates when an attempt is ready to route. *)
Resolve(message) ==
  LET target == Target(LinkOf[message]) IN
    /\ message \in pending
    /\ resolved[message] = None
    /\ resolved' = [resolved EXCEPT ![message] = placement[target]]
    /\ UNCHANGED <<sent, pending, committed, logs, placement, attempts>>

(* Move invalidates pending resolutions for the address whose placement changed. *)
Move(address, place) ==
  /\ place # placement[address]
  /\ placement' = [placement EXCEPT ![address] = place]
  /\ resolved' = [message \in Messages |->
       IF message \in pending /\ Target(LinkOf[message]) = address
       THEN None
       ELSE resolved[message]]
  /\ UNCHANGED <<sent, pending, committed, logs, attempts>>

(* Deliver models the selected Transport committing at the link target and absorbing a retry already present in its log. *)
Deliver(message) ==
  LET target == Target(LinkOf[message]) IN
    /\ message \in pending
    /\ resolved[message] = placement[target]
    /\ attempts[message] < MaxAttempts
    /\ logs' = [logs EXCEPT ![target] =
         IF message \in Values(@) THEN @ ELSE Append(@, message)]
    /\ pending' = pending \ {message}
    /\ committed' = committed \cup {message}
    /\ resolved' = [resolved EXCEPT ![message] = None]
    /\ attempts' = [attempts EXCEPT ![message] = @ + 1]
    /\ UNCHANGED <<sent, placement>>

(* Retry places a committed delivery back in flight within the stated attempt bound. *)
Retry(message) ==
  /\ message \in committed
  /\ message \notin pending
  /\ attempts[message] < MaxAttempts
  /\ pending' = pending \cup {message}
  /\ UNCHANGED <<sent, committed, logs, placement, resolved, attempts>>

Next ==
  \/ \E message \in Messages: Send(message)
  \/ \E message \in Messages: Resolve(message)
  \/ \E address \in Addresses, place \in Places: Move(address, place)
  \/ \E message \in Messages: Deliver(message)
  \/ \E message \in Messages: Retry(message)

StableNext ==
  \/ \E message \in Messages: Send(message)
  \/ \E message \in Messages: Resolve(message)
  \/ \E message \in Messages: Deliver(message)
  \/ \E message \in Messages: Retry(message)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Init
  /\ [][StableNext]_vars
  /\ \A message \in Messages: WF_vars(Resolve(message))
  /\ \A message \in Messages: WF_vars(Deliver(message))

(* NoMisroute states that a message can appear only at its link target. *)
NoMisroute ==
  \A address \in Addresses:
    \A message \in Values(logs[address]): address = Target(LinkOf[message])

(* AtMostOnce states that retries cannot append a message twice. *)
AtMostOnce ==
  \A address \in Addresses, message \in Messages:
    Cardinality({index \in DOMAIN logs[address]: logs[address][index] = message}) <= 1

(* CommittedExactlyLogged states that durable commitment and target-log presence agree. *)
CommittedExactlyLogged == committed = Logged

(* ResolvedIsFresh states that every cached route names the target's current placement. *)
ResolvedIsFresh ==
  \A message \in pending:
    resolved[message] # None => resolved[message] = placement[Target(LinkOf[message])]

(* AllSentDelivered states that fair delivery under stable placement eventually commits every sent message. *)
AllSentDelivered ==
  \A message \in Messages: message \in sent ~> message \in committed

(* StaleMove retains a pending route across migration and supplies the expected freshness counterexample. *)
StaleMove(address, place) ==
  /\ place # placement[address]
  /\ placement' = [placement EXCEPT ![address] = place]
  /\ UNCHANGED <<sent, pending, committed, logs, resolved, attempts>>

StaleNext ==
  \/ \E message \in Messages: Send(message)
  \/ \E message \in Messages: Resolve(message)
  \/ \E address \in Addresses, place \in Places: StaleMove(address, place)

StaleSpec == Init /\ [][StaleNext]_vars

(* Misdeliver appends at the source and supplies the expected routing counterexample. *)
Misdeliver(message) ==
  LET source == Source(LinkOf[message]) IN
    /\ message \in pending
    /\ resolved[message] # None
    /\ attempts[message] < MaxAttempts
    /\ logs' = [logs EXCEPT ![source] = Append(@, message)]
    /\ pending' = pending \ {message}
    /\ committed' = committed \cup {message}
    /\ resolved' = [resolved EXCEPT ![message] = None]
    /\ attempts' = [attempts EXCEPT ![message] = @ + 1]
    /\ UNCHANGED <<sent, placement>>

MisrouteNext ==
  \/ \E message \in Messages: Send(message)
  \/ \E message \in Messages: Resolve(message)
  \/ \E message \in Messages: Misdeliver(message)

MisrouteSpec == Init /\ [][MisrouteNext]_vars

=============================================================================
