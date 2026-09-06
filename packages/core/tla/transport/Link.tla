------------------------------ MODULE Link ------------------------------
(* Link models durable envelope delivery through a directed source and target pair. Actor identities and transport destinations are abstract so the same actions cover local append, remote RPC, and provider ingress. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Identities, Destinations, Links, Envelopes, LinkOf, InitialDirectory, MaxAttempts, None

ASSUME Links \subseteq Identities \X Identities
ASSUME LinkOf \in [Envelopes -> Links]
ASSUME InitialDirectory \in [Identities -> Destinations]
ASSUME None \notin Destinations
ASSUME MaxAttempts \in Nat /\ MaxAttempts > 0

Source(link) == link[1]
Target(link) == link[2]

ModelIdentities == {"telegram", "support", "reviewer"}
ModelDestinations == {"edgeA", "edgeB"}
ModelLinks == {<<"telegram", "support">>, <<"support", "reviewer">>}
ModelEnvelopes == {"m1", "m2"}
ModelLinkOf == [envelope \in ModelEnvelopes |->
  IF envelope = "m1" THEN <<"telegram", "support">> ELSE <<"support", "reviewer">>]
ModelDirectory == [identity \in ModelIdentities |->
  IF identity = "reviewer" THEN "edgeB" ELSE "edgeA"]

TinyIdentities == {"telegram", "support"}
TinyDestinations == {"edgeA", "edgeB"}
TinyLinks == {<<"telegram", "support">>}
TinyEnvelopes == {"m1"}
TinyLinkOf == [envelope \in TinyEnvelopes |-> <<"telegram", "support">>]
TinyDirectory == [identity \in TinyIdentities |-> "edgeA"]

VARIABLES sent, pending, committed, logs, directory, destinationOf, attempts

vars == <<sent, pending, committed, logs, directory, destinationOf, attempts>>

Values(sequence) == {sequence[index] : index \in DOMAIN sequence}
Logged == UNION {Values(logs[identity]) : identity \in Identities}

TypeOK ==
  /\ sent \subseteq Envelopes
  /\ pending \subseteq sent
  /\ committed \subseteq sent
  /\ logs \in [Identities -> Seq(Envelopes)]
  /\ directory \in [Identities -> Destinations]
  /\ destinationOf \in [Envelopes -> Destinations \cup {None}]
  /\ attempts \in [Envelopes -> 0..MaxAttempts]

Init ==
  /\ sent = {}
  /\ pending = {}
  /\ committed = {}
  /\ logs = [identity \in Identities |-> <<>>]
  /\ directory = InitialDirectory
  /\ destinationOf = [envelope \in Envelopes |-> None]
  /\ attempts = [envelope \in Envelopes |-> 0]

(* Send makes one named envelope pending without resolving its target identity. *)
Send(envelope) ==
  /\ envelope \notin sent
  /\ sent' = sent \cup {envelope}
  /\ pending' = pending \cup {envelope}
  /\ UNCHANGED <<committed, logs, directory, destinationOf, attempts>>

(* Resolve models Directory reading the target identity's current transport destination. *)
Resolve(envelope) ==
  LET target == Target(LinkOf[envelope]) IN
    /\ envelope \in pending
    /\ destinationOf[envelope] = None
    /\ destinationOf' = [destinationOf EXCEPT ![envelope] = directory[target]]
    /\ UNCHANGED <<sent, pending, committed, logs, directory, attempts>>

(* Move invalidates pending resolutions for the identity whose directory entry changed. *)
Move(identity, destination) ==
  /\ destination # directory[identity]
  /\ directory' = [directory EXCEPT ![identity] = destination]
  /\ destinationOf' = [envelope \in Envelopes |->
       IF envelope \in pending /\ Target(LinkOf[envelope]) = identity
       THEN None
       ELSE destinationOf[envelope]]
  /\ UNCHANGED <<sent, pending, committed, logs, attempts>>

(* TransportSend models the selected Transport committing at the link target and absorbing a retry already present in its log. *)
TransportSend(envelope) ==
  LET target == Target(LinkOf[envelope]) IN
    /\ envelope \in pending
    /\ destinationOf[envelope] = directory[target]
    /\ attempts[envelope] < MaxAttempts
    /\ logs' = [logs EXCEPT ![target] =
         IF envelope \in Values(@) THEN @ ELSE Append(@, envelope)]
    /\ pending' = pending \ {envelope}
    /\ committed' = committed \cup {envelope}
    /\ destinationOf' = [destinationOf EXCEPT ![envelope] = None]
    /\ attempts' = [attempts EXCEPT ![envelope] = @ + 1]
    /\ UNCHANGED <<sent, directory>>

(* Retry places a committed delivery back in flight within the stated attempt bound. *)
Retry(envelope) ==
  /\ envelope \in committed
  /\ envelope \notin pending
  /\ attempts[envelope] < MaxAttempts
  /\ pending' = pending \cup {envelope}
  /\ UNCHANGED <<sent, committed, logs, directory, destinationOf, attempts>>

Next ==
  \/ \E envelope \in Envelopes: Send(envelope)
  \/ \E envelope \in Envelopes: Resolve(envelope)
  \/ \E identity \in Identities, destination \in Destinations: Move(identity, destination)
  \/ \E envelope \in Envelopes: TransportSend(envelope)
  \/ \E envelope \in Envelopes: Retry(envelope)

StableNext ==
  \/ \E envelope \in Envelopes: Send(envelope)
  \/ \E envelope \in Envelopes: Resolve(envelope)
  \/ \E envelope \in Envelopes: TransportSend(envelope)
  \/ \E envelope \in Envelopes: Retry(envelope)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Init
  /\ [][StableNext]_vars
  /\ \A envelope \in Envelopes: WF_vars(Resolve(envelope))
  /\ \A envelope \in Envelopes: WF_vars(TransportSend(envelope))

(* NoMisroute states that an envelope can appear only at its link target. *)
NoMisroute ==
  \A identity \in Identities:
    \A envelope \in Values(logs[identity]): identity = Target(LinkOf[envelope])

(* AtMostOnce states that retries cannot append an envelope twice. *)
AtMostOnce ==
  \A identity \in Identities, envelope \in Envelopes:
    Cardinality({index \in DOMAIN logs[identity]: logs[identity][index] = envelope}) <= 1

(* CommittedExactlyLogged states that durable commitment and target-log presence agree. *)
CommittedExactlyLogged == committed = Logged

(* ResolvedIsFresh states that every cached route names the target's current transport destination. *)
ResolvedIsFresh ==
  \A envelope \in pending:
    destinationOf[envelope] # None => destinationOf[envelope] = directory[Target(LinkOf[envelope])]

(* AllSentCommitted states that fair transport under a stable directory eventually commits every sent envelope. *)
AllSentCommitted ==
  \A envelope \in Envelopes: envelope \in sent ~> envelope \in committed

(* StaleMove retains a pending route across migration and supplies the expected freshness counterexample. *)
StaleMove(identity, destination) ==
  /\ destination # directory[identity]
  /\ directory' = [directory EXCEPT ![identity] = destination]
  /\ UNCHANGED <<sent, pending, committed, logs, destinationOf, attempts>>

StaleNext ==
  \/ \E envelope \in Envelopes: Send(envelope)
  \/ \E envelope \in Envelopes: Resolve(envelope)
  \/ \E identity \in Identities, destination \in Destinations: StaleMove(identity, destination)

StaleSpec == Init /\ [][StaleNext]_vars

(* Misdeliver appends at the source and supplies the expected routing counterexample. *)
Misdeliver(envelope) ==
  LET source == Source(LinkOf[envelope]) IN
    /\ envelope \in pending
    /\ destinationOf[envelope] # None
    /\ attempts[envelope] < MaxAttempts
    /\ logs' = [logs EXCEPT ![source] = Append(@, envelope)]
    /\ pending' = pending \ {envelope}
    /\ committed' = committed \cup {envelope}
    /\ destinationOf' = [destinationOf EXCEPT ![envelope] = None]
    /\ attempts' = [attempts EXCEPT ![envelope] = @ + 1]
    /\ UNCHANGED <<sent, directory>>

MisrouteNext ==
  \/ \E envelope \in Envelopes: Send(envelope)
  \/ \E envelope \in Envelopes: Resolve(envelope)
  \/ \E envelope \in Envelopes: Misdeliver(envelope)

MisrouteSpec == Init /\ [][MisrouteNext]_vars

=============================================================================
