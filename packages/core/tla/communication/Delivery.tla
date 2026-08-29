---------------------------- MODULE Delivery ----------------------------
(* Threads talking, N of them: the composition tier. Reconcile.tla proves one
   thread's conduct (attempts, crashes, ghosts, terminal-last); this module
   abstracts a thread to its interface (dispatched, then settled once its
   obligations discharge) and proves what composition adds and what it
   can destroy.

   THREE EDGE KINDS, because they carry different liveness character.
   A BRIEF edge spawns: the parent's call dispatches a fresh child and
   the child's settle replies home. Spawns cannot cycle in the real
   system (every fire mints a fresh thread), and the constant Briefs is
   assumed a forest. An AWAIT edge waits on an EXISTING thread's settle
   (the tasks.result shape) and is the only cycle-capable kind.
   A SERVICE edge is a method an actor can settle independently of its
   currently parked turn. Its reply requires the target to be dispatched,
   not settled. The requestBudget call has this shape: a parent may await
   a child while its budget component answers the child's reciprocal call.

   THE THEOREM PAIR. AwaitOrder: waiting, taken transitively over both
   dependency edge kinds, is irreflexive: no thread transitively waits for itself.
   AllSettle (liveness): under fair briefing, replying, and settling,
   every reachable thread settles. AllSettle holds when AwaitOrder does
   (Delivery.cfg, DeliveryLive.cfg: a diamond with a cross await) and
   fails when it does not (DeliveryDeadlock.cfg, expected to fail: a
   two-thread await cycle rests forever with every action disabled and
   every safety invariant content). The failing trace is the deadlock
   the host's sentinel exists to break (packages/host/src/deadlock.ts).

   The topology is a CONSTANT: the spec checks instants, not formation.
   Every reachable dynamic graph at any instant is some static graph,
   and the sentinel checks instants too. *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Threads, Briefs, Awaits, Services, Roots

(* Named topologies, selected by the configs (cfg files cannot write
   tuple sets). The diamond: a spawn tree plus one cross await, order
   intact. The knot: two siblings awaiting each other, the deadlock. *)
DiamondThreads  == {"r", "a", "b", "j"}
DiamondRoots  == {"r"}
DiamondBriefs == {<<"r", "a">>, <<"r", "b">>, <<"r", "j">>}
DiamondAwaits == {<<"a", "b">>}
DiamondServices == {<<"a", "r">>}
KnotThreads  == {"r", "p", "c"}
KnotRoots  == {"r"}
KnotBriefs == {<<"r", "p">>, <<"r", "c">>}
KnotAwaits == {<<"p", "c">>, <<"c", "p">>}
KnotServices == {}

ASSUME Briefs \subseteq Threads \X Threads
ASSUME Awaits \subseteq Threads \X Threads
ASSUME Services \subseteq Threads \X Threads
ASSUME Roots \subseteq Threads

Dependencies == Briefs \cup Awaits
Edges == Dependencies \cup Services

(* Reachability by bounded iteration: paths need at most |Threads| hops.
   Direct quantifiers only, per the house method. *)
Step(R) == R \cup {<<a, c>> \in Threads \X Threads: \E b \in Threads: <<a, b>> \in R /\ <<b, c>> \in Dependencies}
R1 == Step(Dependencies)
R2 == Step(R1)
R3 == Step(R2)
R4 == Step(R3)
Reach == Step(R4)

(* The order theorem: no thread transitively waits for itself. *)
AwaitOrder == \A l \in Threads: <<l, l>> \notin Reach

-----------------------------------------------------------------------
VARIABLES dispatched, settled, replied

vars == <<dispatched, settled, replied>>

TypeOK ==
  /\ dispatched \subseteq Threads
  /\ settled \subseteq dispatched
  /\ replied \subseteq Edges

Init ==
  /\ dispatched = Roots
  /\ settled = {}
  /\ replied = {}

(* A dispatched parent briefs a child: the child's thread is born. *)
Brief(p, c) ==
  /\ <<p, c>> \in Briefs
  /\ p \in dispatched
  /\ c \notin dispatched
  /\ dispatched' = dispatched \cup {c}
  /\ UNCHANGED <<settled, replied>>

(* A settled thread's reply discharges one settlement-dependent edge that waited on it. The
   reply is an ordinary append at the receiver; at-least-once and dedup
   are Reconcile.tla's business, abstracted here to the one durable fact. *)
ReplySettled(a, b) ==
  /\ <<a, b>> \in Dependencies
  /\ b \in settled
  /\ <<a, b>> \notin replied
  /\ replied' = replied \cup {<<a, b>>}
  /\ UNCHANGED <<dispatched, settled>>

(* A component-served method may answer while another turn on the target thread remains parked. *)
ReplyService(a, b) ==
  /\ <<a, b>> \in Services
  /\ b \in dispatched
  /\ <<a, b>> \notin replied
  /\ replied' = replied \cup {<<a, b>>}
  /\ UNCHANGED <<dispatched, settled>>

(* A thread settles once every obligation is discharged: every child it
   briefs has replied, and every thread it awaits has replied. *)
Obligations(l) == {<<a, b>> \in Edges: a = l}

Settle(l) ==
  /\ l \in dispatched
  /\ l \notin settled
  /\ Obligations(l) \subseteq replied
  /\ settled' = settled \cup {l}
  /\ UNCHANGED <<dispatched, replied>>

Next ==
  \/ \E p \in Threads, c \in Threads: Brief(p, c)
  \/ \E a \in Threads, b \in Threads: ReplySettled(a, b)
  \/ \E a \in Threads, b \in Threads: ReplyService(a, b)
  \/ \E l \in Threads: Settle(l)

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ \A p \in Threads, c \in Threads: WF_vars(Brief(p, c))
  /\ \A a \in Threads, b \in Threads: WF_vars(ReplySettled(a, b))
  /\ \A a \in Threads, b \in Threads: WF_vars(ReplyService(a, b))
  /\ \A l \in Threads: WF_vars(Settle(l))

-----------------------------------------------------------------------
(* Reachable threads: the roots and everything briefing reaches. *)
Reachable == Roots \cup {c \in Threads: \E r \in Roots: <<r, c>> \in Reach}

(* The capstone: every reachable thread settles. Holds iff AwaitOrder. *)
AllSettle == <>(Reachable \subseteq settled)

(* Safety stays content either way: the deadlock is not a violation of
   any invariant, which is the whole reason it needs a sentinel. *)
SettledAreDispatched == settled \subseteq dispatched

=======================================================================
