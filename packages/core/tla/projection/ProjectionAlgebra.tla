------------------------- MODULE ProjectionAlgebra -------------------------
(* ProjectionAlgebra checks a finite behavioral quotient. Histories compose by concatenation, Product projects balance and audit state, Observe factors behavior through that projection, and FutureEquivalent compares every bounded continuation. *)

EXTENDS Naturals, Integers, Sequences, FiniteSets, TLC

CONSTANT MaxLen

Events == {"up", "down", "audit"}
Histories == UNION {[1..length -> Events]: length \in 0..MaxLen}

Ups(history) == Cardinality({index \in DOMAIN history: history[index] = "up"})
Downs(history) == Cardinality({index \in DOMAIN history: history[index] = "down"})
Balance(history) == Ups(history) - Downs(history)
Audited(history) == \E index \in DOMAIN history: history[index] = "audit"

EmptyProjection == [balance |-> 0, audited |-> FALSE]

Product(history) ==
  [balance |-> Balance(history), audited |-> Audited(history)]

Combine(left, right) ==
  [balance |-> left.balance + right.balance,
   audited |-> left.audited \/ right.audited]

Reduce(state, event) == Combine(state, Product(<<event>>))

Observe(state) ==
  [nonnegative |-> state.balance >= 0,
   audited |-> state.audited]

Outcome(history) ==
  [nonnegative |-> Balance(history) >= 0,
   audited |-> Audited(history)]

CurrentOutput(history) == Outcome(history)

FutureEquivalent(left, right) ==
  \A suffix \in Histories:
    Outcome(left \o suffix) = Outcome(right \o suffix)

BalanceEquivalent(left, right) ==
  \A suffix \in Histories:
    (Balance(left \o suffix) >= 0) = (Balance(right \o suffix) >= 0)

AuditEquivalent(left, right) ==
  \A suffix \in Histories:
    Audited(left \o suffix) = Audited(right \o suffix)

VARIABLES leftHistory, rightHistory

vars == <<leftHistory, rightHistory>>

Init ==
  /\ leftHistory = <<>>
  /\ rightHistory = <<>>

ExtendLeft(event) ==
  /\ Len(leftHistory) < MaxLen
  /\ leftHistory' = Append(leftHistory, event)
  /\ UNCHANGED rightHistory

ExtendRight(event) ==
  /\ Len(rightHistory) < MaxLen
  /\ rightHistory' = Append(rightHistory, event)
  /\ UNCHANGED leftHistory

Next ==
  \/ \E event \in Events: ExtendLeft(event)
  \/ \E event \in Events: ExtendRight(event)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ leftHistory \in Histories
  /\ rightHistory \in Histories

(* Factorization states that complete-history behavior observes only Product. *)
Factorization ==
  \A history \in Histories:
    Outcome(history) = Observe(Product(history))

(* ReducerLaw states that one event advances Product without replaying its prefix. *)
ReducerLaw ==
  \A history \in Histories:
    \A event \in Events:
      Product(Append(history, event)) = Reduce(Product(history), event)

(* Homomorphism states that a concatenated history projects by combining its segment projections. *)
Homomorphism ==
  \A left \in Histories:
    \A right \in Histories:
      Product(left \o right) = Combine(Product(left), Product(right))

(* IdentityLaw states that the empty projection is the identity for every reachable projection. *)
IdentityLaw ==
  \A history \in Histories:
    /\ Combine(EmptyProjection, Product(history)) = Product(history)
    /\ Combine(Product(history), EmptyProjection) = Product(history)

(* AssociativityLaw states that grouping does not change composition of reachable projections. *)
AssociativityLaw ==
  \A first \in Histories:
    \A second \in Histories:
      \A third \in Histories:
        Combine(Combine(Product(first), Product(second)), Product(third))
        = Combine(Product(first), Combine(Product(second), Product(third)))

(* ProductSufficient states that histories collapsed by Product remain indistinguishable under every bounded continuation. *)
ProductSufficient ==
  \A left \in Histories:
    \A right \in Histories:
      Product(left) = Product(right) => FutureEquivalent(left, right)

(* ProductMinimal states that every distinct reachable projection has a bounded continuation that distinguishes its behavior. *)
ProductMinimal ==
  \A left \in Histories:
    \A right \in Histories:
      FutureEquivalent(left, right) => Product(left) = Product(right)

(* QuotientExact states that Product represents exactly the bounded future-equivalence classes. *)
QuotientExact ==
  \A left \in Histories:
    \A right \in Histories:
      (Product(left) = Product(right)) = FutureEquivalent(left, right)

(* CompositionIntersection states that actor equivalence is the intersection of its component equivalences. *)
CompositionIntersection ==
  \A left \in Histories:
    \A right \in Histories:
      FutureEquivalent(left, right)
      = (BalanceEquivalent(left, right) /\ AuditEquivalent(left, right))

(* EquivalenceRelation checks reflexivity, symmetry, and transitivity of bounded future equivalence. *)
EquivalenceRelation ==
  /\ \A history \in Histories: FutureEquivalent(history, history)
  /\ \A left \in Histories:
       \A right \in Histories:
         FutureEquivalent(left, right) => FutureEquivalent(right, left)
  /\ \A first \in Histories:
       \A second \in Histories:
         \A third \in Histories:
           FutureEquivalent(first, second) /\ FutureEquivalent(second, third)
           => FutureEquivalent(first, third)

(* RightCongruence states that equivalent histories remain equivalent after the same future prefix. *)
RightCongruence ==
  \A left \in Histories:
    \A right \in Histories:
      \A suffix \in Histories:
        FutureEquivalent(left, right)
        => FutureEquivalent(left \o suffix, right \o suffix)

(* ReducerWellDefined states that Reduce acts on quotient states independently of the representative history. *)
ReducerWellDefined ==
  \A left \in Histories:
    \A right \in Histories:
      Product(left) = Product(right)
      => \A event \in Events:
           Reduce(Product(left), event) = Reduce(Product(right), event)

(* CurrentOutputSufficient claims that the current pair's equal behavior now implies equal behavior under every bounded continuation. The lossy projection makes this claim false. *)
CurrentOutputSufficient ==
  CurrentOutput(leftHistory) = CurrentOutput(rightHistory)
  => FutureEquivalent(leftHistory, rightHistory)

(* BalanceOnlySufficient claims that one component projection represents the composed actor. Audit behavior makes this claim false. *)
BalanceOnlySufficient ==
  Balance(leftHistory) = Balance(rightHistory)
  => FutureEquivalent(leftHistory, rightHistory)

=============================================================================
