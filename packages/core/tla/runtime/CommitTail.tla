----------------------------- MODULE CommitTail -----------------------------
EXTENDS Naturals

CONSTANT MaxHead, ReplayLatest

VARIABLES durableHead, signalHead, cursor, mode

vars == <<durableHead, signalHead, cursor, mode>>

Init ==
  /\ durableHead = 0
  /\ signalHead = 0
  /\ cursor = 0
  /\ mode = "active"

Append ==
  /\ durableHead < MaxHead
  /\ durableHead' = durableHead + 1
  /\ UNCHANGED <<signalHead, cursor, mode>>

Publish ==
  /\ signalHead < durableHead
  /\ signalHead' = IF ReplayLatest \/ mode = "waiting" THEN durableHead ELSE signalHead
  /\ UNCHANGED <<durableHead, cursor, mode>>

ReadAvailable ==
  /\ mode = "active"
  /\ cursor < durableHead
  /\ cursor' = durableHead
  /\ UNCHANGED <<durableHead, signalHead, mode>>

ReadEmpty ==
  /\ mode = "active"
  /\ cursor = durableHead
  /\ mode' = "subscribing"
  /\ UNCHANGED <<durableHead, signalHead, cursor>>

Subscribe ==
  /\ mode = "subscribing"
  /\ mode' = IF ReplayLatest /\ signalHead > cursor THEN "active" ELSE "waiting"
  /\ UNCHANGED <<durableHead, signalHead, cursor>>

Wake ==
  /\ mode = "waiting"
  /\ signalHead > cursor
  /\ mode' = "active"
  /\ UNCHANGED <<durableHead, signalHead, cursor>>

Next == Append \/ Publish \/ ReadAvailable \/ ReadEmpty \/ Subscribe \/ Wake

Spec ==
  /\ Init
  /\ [][Next]_vars
  /\ WF_vars(Publish)
  /\ WF_vars(ReadAvailable)
  /\ WF_vars(ReadEmpty)
  /\ WF_vars(Subscribe)
  /\ WF_vars(Wake)

TypeOK ==
  /\ durableHead \in 0..MaxHead
  /\ signalHead \in 0..MaxHead
  /\ cursor \in 0..MaxHead
  /\ mode \in {"active", "subscribing", "waiting"}

SignalIsDurable == signalHead <= durableHead
CursorIsDurable == cursor <= durableHead
CommittedEventuallyRead == (cursor < durableHead) ~> (cursor = durableHead)

=============================================================================
