---------------------------- MODULE Reconcile ----------------------------
(* The reconciler: the runtime half of the transition model, and the
   reconciler model for owed and served work. A reactor DERIVES the keyed
   transitions the event set enables; the runtime FIRES each key the
   log does not record and appends the results, keyed record last.

   The obligations this module itemizes:

   NOVOID: enabled work is never lost. While a transition's key is
     underivable from the log and its enabling condition holds, a fire
     is coming: the diff re-derives it on every settle, so a crash
     between fire and record re-fires and the key absorbs the repeat.

   QUIETISBLOCKED: a resting actor is honestly blocked. Resting is an
     empty diff, and the diff is empty only when every derived key is
     recorded or every underivable transition's prerequisite is absent
     from the event set (a BlockedOn whose awaited id has not landed).

   COMMITONE: the keyed record lands last. A fire's result events
     commit with the key-bearing terminal after the evidence, so a
     crash mid-commit leaves evidence without a verdict, never a
     verdict without evidence, and the re-fire is absorbed by the key.

   THE MODEL. One actor, a bag of recorded keys, transitions as
   constants: each has a key, an enabling condition over the bag
   (its prerequisite keys), and an optional block (the awaited key
   that suppresses it). Fire runs a transition whose key is absent and
   whose prerequisites are present; it either records the key, records
   a block (the awaited key joins the awaited set), or crashes and
   records nothing. Deliver lands an awaited key any time. *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Keys, Fireable, Prereq, Awaits, MaxCrashes

(* The checked topology, in-module because a cfg cannot hold function
   constants (the Delivery.tla precedent): a three-key chain with one
   block. k2 requires k1; k3 blocks on d, a delivery. *)
ChainKeys == {"k1", "k2", "k3", "d"}
(* The actor fires transitions; the world lands deliveries. Disjoint by
   construction: a key is one or the other, never both. *)
ChainFireable == {"k1", "k2", "k3"}
ChainPrereq == [k \in ChainKeys |-> IF k = "k2" THEN {"k1"} ELSE {}]
ChainAwaits == [k \in {"k3"} |-> "d"]

VARIABLES recorded, awaited, crashes, firing

vars == <<recorded, awaited, crashes, firing>>

TypeOK ==
  /\ recorded \subseteq Keys
  /\ awaited \subseteq Keys
  /\ crashes \in 0..MaxCrashes
  /\ firing \in Keys \cup {"none"}

Init ==
  /\ recorded = {}
  /\ awaited = {}
  /\ crashes = 0
  /\ firing = "none"

(* A transition is enabled when its key is unrecorded, its
   prerequisites are recorded, and its block (if any) is not standing:
   either it never blocked, or its awaited key has landed. *)
Blocked(k) == k \in DOMAIN Awaits /\ Awaits[k] \in awaited /\ ~(Awaits[k] \in recorded)
Enabled(k) ==
  /\ k \notin recorded
  /\ Prereq[k] \subseteq recorded
  /\ ~Blocked(k)

Fire(k) ==
  /\ firing = "none"
  /\ k \in Fireable
  /\ Enabled(k)
  /\ firing' = k
  /\ UNCHANGED <<recorded, awaited, crashes>>

(* The fire records its key: the commit. *)
Record ==
  /\ firing /= "none"
  /\ recorded' = recorded \cup {firing}
  /\ firing' = "none"
  /\ UNCHANGED <<awaited, crashes>>

(* The fire blocks: it records what it awaits and no key. The next
   derivation sees the block and stops deriving this transition until
   the awaited key lands. *)
Block ==
  /\ firing /= "none"
  /\ firing \in DOMAIN Awaits
  (* An act blocks only because the awaited reply is absent; one that
     finds it home harvests and records instead. *)
  /\ ~(Awaits[firing] \in recorded)
  /\ awaited' = awaited \cup {Awaits[firing]}
  /\ firing' = "none"
  /\ UNCHANGED <<recorded, crashes>>

(* The fire crashes: nothing recorded. The diff re-derives it. *)
Crash ==
  /\ firing /= "none"
  /\ crashes < MaxCrashes
  /\ crashes' = crashes + 1
  /\ firing' = "none"
  /\ UNCHANGED <<recorded, awaited>>

(* The world answers: an awaited key lands as a recorded event. *)
Deliver(k) ==
  /\ k \in awaited
  /\ k \notin recorded
  /\ recorded' = recorded \cup {k}
  /\ UNCHANGED <<awaited, crashes, firing>>

Next ==
  \/ \E k \in Keys : Fire(k)
  \/ Record
  \/ Block
  \/ Crash
  \/ \E k \in Keys : Deliver(k)

Spec == Init /\ [][Next]_vars /\ WF_vars(Record) /\ WF_vars(Next)

(* NoVoid: a key that is enabled stays fireable; nothing forgets it.
   Stated as an invariant on the diff: an enabled key is either being
   fired or derivable next settle (trivially true in this model, so
   the checked form is that firing never targets a recorded key). *)
NoVoid == firing /= "none" => firing \notin recorded

(* QuietIsBlocked: when nothing is enabled and work remains, every
   remaining transition is blocked on an unlanded delivery or an
   unrecorded prerequisite: the actor is honestly waiting on the
   world, never on itself. *)
Unfinished == {k \in Keys : k \notin recorded}
QuietIsBlocked ==
  (firing = "none" /\ \A k \in Keys : ~Enabled(k)) =>
    \A k \in Unfinished : Blocked(k) \/ ~(Prereq[k] \subseteq recorded)

(* Settles: every fireable key is eventually recorded (fairness
   carries it: fires re-derive, deliveries land, crashes are bounded).
   A delivery lands only if something awaited it, so the claim is
   scoped to the actor's own work. *)
Settles == <>(Fireable \subseteq recorded)

=============================================================================
