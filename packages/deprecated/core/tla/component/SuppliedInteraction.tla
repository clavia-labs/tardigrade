----------------------- MODULE SuppliedInteraction -----------------------
EXTENDS Naturals, Sequences, FiniteSets

(* SuppliedInteraction models a receiver capability passed to a source component. The source binds a pure description to a recorded occurrence and tag; only Commit publishes it. Fault configurations remove one obligation at a time. *)
CONSTANT Fault
Sources == {"first", "second", "foreign"}
Receivers == {"left", "right"}
Receiver(s) == IF s = "foreign" THEN "right" ELSE "left"
Component(s) == IF s = "foreign" THEN "other" ELSE "alarms"
Tag(s) == IF s = "second" THEN "wake:second" ELSE "wake:first"

VARIABLES owners, withdrawn, log, offered, head, noise, premature
vars == <<owners, withdrawn, log, offered, head, noise, premature>>
Entries == {log[i] : i \in 1..Len(log)}
Delivered == {e.source : e \in Entries}
Origin(s) == <<owners[s], Component(s), Tag(s)>>

Init ==
  /\ owners = [s \in Sources |-> 0]
  /\ withdrawn = {}
  /\ log = <<>>
  /\ offered = {}
  /\ head = 0
  /\ noise = 0
  /\ premature = FALSE

(* Record permits several requests to share one triggering event, as alarms due on the same host wake do. *)
Record(batch) ==
  /\ batch # {}
  /\ \A s \in batch : owners[s] = 0
  /\ owners' = [s \in Sources |-> IF s \in batch THEN head + 1 ELSE owners[s]]
  /\ head' = head + 1
  /\ UNCHANGED <<withdrawn, log, offered, noise, premature>>

Describe(s, receiver) ==
  /\ owners[s] > 0
  /\ s \notin withdrawn
  /\ Fault = "scope" \/ receiver = Receiver(s)
  /\ LET p == [source |-> s, target |-> receiver,
                key |-> <<IF Fault = "head" THEN head ELSE owners[s],
                           Component(s), IF Fault = "tag" THEN "wake" ELSE Tag(s)>>]
     IN /\ p \notin offered
        /\ offered' = offered \cup {p}
  /\ premature' = (premature \/ Fault = "eager")
  /\ UNCHANGED <<owners, withdrawn, log, head, noise>>

Withdraw(s) ==
  /\ owners[s] > 0
  /\ s \notin withdrawn \cup Delivered
  /\ withdrawn' = withdrawn \cup {s}
  /\ head' = head + 1
  /\ UNCHANGED <<owners, log, offered, noise, premature>>

(* Commit revalidates a captured proposal and deduplicates its recorded reference atomically. *)
Commit(p) ==
  /\ Len(log) < Cardinality(Sources)
  /\ Fault = "stale" \/ p.source \notin withdrawn
  /\ Fault = "duplicate" \/ ~\E e \in Entries : e.key = p.key
  /\ log' = Append(log, [source |-> p.source, target |-> p.target, key |-> p.key,
                         active |-> p.source \notin withdrawn])
  /\ offered' = offered \ {p}
  /\ head' = head + 1
  /\ UNCHANGED <<owners, withdrawn, noise, premature>>

Noise ==
  /\ noise = 0
  /\ noise' = 1
  /\ head' = head + 1
  /\ UNCHANGED <<owners, withdrawn, log, offered, premature>>

(* Restart discards volatile proposals while retaining recorded origins and completions. *)
Restart ==
  /\ offered # {}
  /\ offered' = {}
  /\ UNCHANGED <<owners, withdrawn, log, head, noise, premature>>

Deliver(s) == \E p \in offered : p.source = s /\ Commit(p)
Next ==
  \/ \E batch \in SUBSET Sources : Record(batch)
  \/ \E s \in Sources, receiver \in Receivers : Describe(s, receiver)
  \/ \E s \in Sources : Withdraw(s)
  \/ \E p \in offered : Commit(p)
  \/ Noise
  \/ Restart
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ owners \in [Sources -> 0..10]
  /\ withdrawn \subseteq {s \in Sources : owners[s] > 0}
  /\ Len(log) <= Cardinality(Sources)
  /\ head \in 0..10
  /\ noise \in 0..1
  /\ premature \in BOOLEAN
  /\ \A p \in offered \cup Entries :
       /\ p.source \in Sources
       /\ owners[p.source] > 0
       /\ p.target \in Receivers

DescriptionIsPure == ~premature
ReceiverIsPreserved == \A p \in offered \cup Entries : p.target = Receiver(p.source)
SourceOwnsIdentity == \A p \in offered \cup Entries : p.key = Origin(p.source)
DistinctRequests == \A p, q \in offered \cup Entries : p.key = q.key => p.source = q.source
AtMostOneCommit == \A s \in Sources : Cardinality({i \in 1..Len(log) : log[i].source = s}) <= 1
NoWithdrawnCommit == \A e \in Entries : e.active

(* LiveSpec assumes strong fairness for description and commitment, even when restarts repeatedly discard proposals. It permits explicit withdrawal and does not promise progress under permanent policy suppression. *)
LiveSpec == Spec /\ \A s \in Sources :
  SF_vars(Describe(s, Receiver(s))) /\ SF_vars(Deliver(s))
Resolution == \A s \in Sources : (owners[s] > 0) ~> (s \in Delivered \cup withdrawn)
=============================================================================
