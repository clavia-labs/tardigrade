------------------------- MODULE TransitionIdentity -------------------------
EXTENDS Naturals, FiniteSets

(* TransitionIdentity models log-local ownership and completion correlation (ExactResolution, AllResolved). The durable log is abstracted to its next append position, owning positions, and committed completion references. Completion order is discarded after assigning positions; no identity operation reads that order. *)

CONSTANTS Components, Tags, MaxOwners, MaxNoise, KeyMode, Fair
VARIABLES nextSeq, owners, noise, committed, resolved
vars == <<nextSeq, owners, noise, committed, resolved>>

(* Ref binds a stable local tag to its component and owning event position. Components are distinct stable identities; tags denote distinct obligations for the whole lifetime of that owner. Reusing a tag for a different obligation violates this assumption even if the two declarations never coexist. *)
Ref(seq, component, tag) == [seq |-> seq, component |-> component, tag |-> tag]
Effects == {Ref(s, c, t) : s \in owners, c \in Components, t \in Tags}

Key(r) == CASE KeyMode = "full" -> <<r.seq, r.component, r.tag>>
           [] KeyMode = "noOwner" -> <<r.component, r.tag>>
           [] KeyMode = "noComponent" -> <<r.seq, r.tag>>
           [] KeyMode = "noTag" -> <<r.seq, r.component>>
Matches(receipts) == {r \in Effects : \E receipt \in receipts : Key(r) = Key(receipt)}
Pending == Effects \ resolved

Init ==
  /\ nextSeq = 1
  /\ owners = {}
  /\ noise = 0
  /\ committed = {}
  /\ resolved = {}

AppendOwner ==
  /\ Cardinality(owners) < MaxOwners
  /\ owners' = owners \cup {nextSeq}
  /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED <<noise, committed, resolved>>

AppendNoise ==
  /\ noise < MaxNoise
  /\ noise' = noise + 1
  /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED <<owners, committed, resolved>>

(* Complete represents an effect that returns and durably commits its runtime-attached reference. Retries before a durable completion are stuttering steps; the model makes no exactly-once claim about external execution. *)
Complete(r) ==
  /\ r \in Pending
  /\ committed' = committed \cup {r}
  /\ resolved' = resolved \cup Matches({r})
  /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED <<owners, noise>>

Replay ==
  /\ resolved' = Matches(committed)
  /\ UNCHANGED <<nextSeq, owners, noise, committed>>

Next == AppendOwner \/ AppendNoise \/ (\E r \in Effects : Complete(r)) \/ Replay

(* Universe bounds TLC exploration; the safety argument below does not depend on these bounds. Each owner contributes one event and at most |Components| * |Tags| completions. *)
MaxPosition == MaxNoise + MaxOwners * (1 + Cardinality(Components) * Cardinality(Tags))
Universe == {Ref(s, c, t) : s \in 1..MaxPosition, c \in Components, t \in Tags}
Progress == \A r \in Universe : WF_vars(Complete(r))
Spec == Init /\ [][Next]_vars /\ (IF Fair THEN Progress ELSE TRUE)

TypeOK ==
  /\ nextSeq \in 1..(MaxPosition + 1)
  /\ owners \subseteq 1..(nextSeq - 1)
  /\ Cardinality(owners) <= MaxOwners
  /\ noise \in 0..MaxNoise
  /\ committed \subseteq Effects
  /\ resolved \subseteq Effects

PositionAccounting == nextSeq = 1 + Cardinality(owners) + noise + Cardinality(committed)
ExactResolution == resolved = committed
ReplayStable == Matches(committed) = resolved
AllResolved == \A r \in Universe : (r \in Effects ~> r \in resolved)

(* IdentityInjective follows from equality of tuples: Key(a) = Key(b) implies a.seq = b.seq, a.component = b.component, and a.tag = b.tag. Record extensionality then gives a = b. This argument holds for arbitrary coordinate sets when KeyMode = "full". The TypeScript encoding additionally relies on JSON array encoding being injective on positive safe integers and strings (src/transition/transition.ts, TransitionRef and transitionKey). *)
IdentityInjective == \A a, b \in Effects : Key(a) = Key(b) => a = b

(* ExactResolution is inductive for KeyMode = "full". Init makes both sets empty. AppendOwner uses nextSeq, which exceeds every existing owner position, so new effects cannot equal old effects or receipts. AppendNoise changes no references. IdentityInjective gives Matches({r}) = {r}, so Complete adds exactly r to both sets. Replay uses Matches(committed) = committed and restores the same resolved set. Stuttering preserves the equality. Thus Spec implies []ExactResolution and []ReplayStable for arbitrary bounds. PositionAccounting follows because each append adds one event; a completed pending reference is fresh by ExactResolution. *)

(* AllResolved follows under Progress. Once r exists it remains in Effects. While unresolved, ExactResolution keeps it pending and Complete(r) remains enabled through owner appends, other completions, and replay. Weak fairness eventually takes Complete(r), which resolves r. This assumes the obligation remains offered and its action can return and commit; cancellation, changing tags, and effects that never return are outside this model. *)

=============================================================================
