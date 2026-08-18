---------------------------- MODULE Delivery ----------------------------
(* Lanes talking, N of them: the composition tier. Reactor.tla proves one
   lane's conduct (attempts, crashes, ghosts, terminal-last); this module
   abstracts a lane to its interface (dispatched, then settled once its
   obligations discharge) and proves what composition adds and what it
   can destroy.

   TWO EDGE KINDS, because they carry different liveness character.
   A BRIEF edge spawns: the parent's call dispatches a fresh child and
   the child's settle replies home. Spawns cannot cycle in the real
   system (every fire mints a fresh lane), and the constant Briefs is
   assumed a forest. An AWAIT edge waits on an EXISTING lane's settle
   (the tasks.result shape) and is the only cycle-capable kind.

   THE THEOREM PAIR. AwaitOrder: waiting, taken transitively over both
   edge kinds, is irreflexive: no lane transitively waits for itself.
   AllSettle (liveness): under fair briefing, replying, and settling,
   every reachable lane settles. AllSettle holds when AwaitOrder does
   (Delivery.cfg, DeliveryLive.cfg: a diamond with a cross await) and
   fails when it does not (DeliveryDeadlock.cfg, expected to fail: a
   two-lane await cycle rests forever with every action disabled and
   every safety invariant content). The failing trace is the deadlock
   the host's sentinel exists to break (packages/host/src/deadlock.ts).

   The topology is a CONSTANT: the spec checks instants, not formation.
   Every reachable dynamic graph at any instant is some static graph,
   and the sentinel checks instants too. *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Lanes, Briefs, Awaits, Roots

(* Named topologies, selected by the configs (cfg files cannot write
   tuple sets). The diamond: a spawn tree plus one cross await, order
   intact. The knot: two siblings awaiting each other, the deadlock. *)
DiamondLanes  == {"r", "a", "b", "j"}
DiamondRoots  == {"r"}
DiamondBriefs == {<<"r", "a">>, <<"r", "b">>, <<"r", "j">>}
DiamondAwaits == {<<"a", "b">>}
KnotLanes  == {"r", "p", "c"}
KnotRoots  == {"r"}
KnotBriefs == {<<"r", "p">>, <<"r", "c">>}
KnotAwaits == {<<"p", "c">>, <<"c", "p">>}

ASSUME Briefs \subseteq Lanes \X Lanes
ASSUME Awaits \subseteq Lanes \X Lanes
ASSUME Roots \subseteq Lanes

Edges == Briefs \cup Awaits

(* Reachability by bounded iteration: paths need at most |Lanes| hops.
   Direct quantifiers only, per the house method. *)
Step(R) == R \cup {<<a, c>> \in Lanes \X Lanes: \E b \in Lanes: <<a, b>> \in R /\ <<b, c>> \in Edges}
R1 == Step(Edges)
R2 == Step(R1)
R3 == Step(R2)
R4 == Step(R3)
Reach == Step(R4)

(* The order theorem: no lane transitively waits for itself. *)
AwaitOrder == \A l \in Lanes: <<l, l>> \notin Reach

-----------------------------------------------------------------------
VARIABLES dispatched, settled, replied

vars == <<dispatched, settled, replied>>

TypeOK ==
  /\ dispatched \subseteq Lanes
  /\ settled \subseteq dispatched
  /\ replied \subseteq Edges

Init ==
  /\ dispatched = Roots
  /\ settled = {}
  /\ replied = {}

(* A dispatched parent briefs a child: the child's lane is born. *)
Brief(p, c) ==
  /\ <<p, c>> \in Briefs
  /\ p \in dispatched
  /\ c \notin dispatched
  /\ dispatched' = dispatched \cup {c}
  /\ UNCHANGED <<settled, replied>>

(* A settled lane's reply discharges one edge that waited on it. The
   reply is an ordinary append at the receiver; at-least-once and dedup
   are Reactor.tla's business, abstracted here to the one durable fact. *)
Reply(a, b) ==
  /\ <<a, b>> \in Edges
  /\ b \in settled
  /\ <<a, b>> \notin replied
  /\ replied' = replied \cup {<<a, b>>}
  /\ UNCHANGED <<dispatched, settled>>

(* A lane settles once every obligation is discharged: every child it
   briefs has replied, and every lane it awaits has replied. *)
Obligations(l) == {<<a, b>> \in Edges: a = l}

Settle(l) ==
  /\ l \in dispatched
  /\ l \notin settled
  /\ Obligations(l) \subseteq replied
  /\ settled' = settled \cup {l}
  /\ UNCHANGED <<dispatched, replied>>

Next ==
  \/ \E p \in Lanes, c \in Lanes: Brief(p, c)
  \/ \E a \in Lanes, b \in Lanes: Reply(a, b)
  \/ \E l \in Lanes: Settle(l)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ \A p \in Lanes, c \in Lanes: WF_vars(Brief(p, c))
  /\ \A a \in Lanes, b \in Lanes: WF_vars(Reply(a, b))
  /\ \A l \in Lanes: WF_vars(Settle(l))

-----------------------------------------------------------------------
(* Reachable lanes: the roots and everything briefing reaches. *)
Reachable == Roots \cup {c \in Lanes: \E r \in Roots: <<r, c>> \in Reach}

(* The capstone: every reachable lane settles. Holds iff AwaitOrder. *)
AllSettle == <>(Reachable \subseteq settled)

(* Safety stays content either way: the deadlock is not a violation of
   any invariant, which is the whole reason it needs a sentinel. *)
SettledAreDispatched == settled \subseteq dispatched

=======================================================================
