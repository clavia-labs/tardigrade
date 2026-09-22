---------------------- MODULE Composition ----------------------
(* Composition checks ordered products with an explicit data-view algebra and pure selection wrappers (Composition.cfg). *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANT MaxLen
Names == {"a", "b", "c"}
Policies == {"identity", "first", "only-b", "reverse"}

VARIABLE history
vars == <<history>>
Init == history = <<>>
Next == /\ Len(history) < MaxLen
        /\ \E name \in Names: history' = Append(history, name)
Spec == Init /\ [][Next]_vars

Count(name) == Cardinality({i \in DOMAIN history: history[i] = name})
Leaf(name) == [view |-> [names |-> <<name>>, count |-> Count(name)],
               proposals |-> IF Count(name) = 0 THEN <<>> ELSE <<name>>]
Empty == [view |-> [names |-> <<>>, count |-> 0], proposals |-> <<>>]

(* Merge uses concatenation and sum as its chosen view algebra (composition/laws.properties.test.ts). *)
Merge(a, b) == [view |-> [names |-> a.view.names \o b.view.names,
                          count |-> a.view.count + b.view.count],
                proposals |-> a.proposals \o b.proposals]

Select(policy, proposals) ==
  CASE policy = "identity" -> proposals
    [] policy = "first" -> IF Len(proposals) = 0 THEN <<>> ELSE <<Head(proposals)>>
    [] policy = "only-b" -> SelectSeq(proposals, LAMBDA p: p = "b")
    [] policy = "reverse" -> [i \in 1..Len(proposals) |-> proposals[Len(proposals) + 1 - i]]

Wrap(policy, child) == [child EXCEPT !.proposals = Select(policy, @)]
Members(s) == {s[i]: i \in DOMAIN s}
All == Merge(Merge(Leaf("a"), Leaf("b")), Leaf("c"))

TypeOK == history \in UNION {[1..n -> Names]: n \in 0..MaxLen}
SiblingIdentity == /\ Merge(Empty, All) = All
                   /\ Merge(All, Empty) = All
SiblingAssociativity ==
  Merge(Merge(Leaf("a"), Leaf("b")), Leaf("c")) =
  Merge(Leaf("a"), Merge(Leaf("b"), Leaf("c")))
ViewProjection == All.view.count = Len(history)
WrapperIdentity == Wrap("identity", All) = All
WrapperComposition ==
  \A p, q, r \in Policies:
    Wrap(p, Wrap(q, Wrap(r, All))) =
    [All EXCEPT !.proposals = Select(p, Select(q, Select(r, @)))]
SelectionBoundary ==
  \A p, q \in Policies:
    LET inner == Wrap(q, All)
        outer == Wrap(p, inner)
    IN /\ Members(outer.proposals) \subseteq Members(inner.proposals)
       /\ Cardinality(Members(outer.proposals)) = Len(outer.proposals)
       /\ outer.view = All.view

(* SiblingCommutativity is a deliberately false equation (CompositionOrder.cfg). *)
SiblingCommutativity == Merge(Leaf("a"), Leaf("b")) = Merge(Leaf("b"), Leaf("a"))
WrapperCommutativity == Wrap("first", Wrap("only-b", All)) = Wrap("only-b", Wrap("first", All))
WrapperDistribution ==
  Wrap("first", Merge(Leaf("a"), Leaf("b"))) =
  Merge(Wrap("first", Leaf("a")), Wrap("first", Leaf("b")))

Average(a, b) == (a + b) \div 2
ArbitraryProjectionAssociativity ==
  Average(Average(Count("a"), Count("b")), Count("c")) =
  Average(Count("a"), Average(Count("b"), Count("c")))

Lossy(n) == n > 0
Decrement(n) == IF n = 0 THEN 0 ELSE n - 1
ViewDeterminesFuture ==
  Lossy(Count("a")) = Lossy(Count("b")) =>
  Lossy(Decrement(Count("a"))) = Lossy(Decrement(Count("b")))

=============================================================================
