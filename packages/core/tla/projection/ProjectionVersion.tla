------------------------- MODULE ProjectionVersion -------------------------
(* ProjectionVersion models a budget reactor upgrade from total usage to per-provider usage. Fine state can migrate to coarse state by forgetting provider identity, while coarse state cannot reconstruct the distinctions required by the new OpenAI-specific policy. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS MaxLen, OpenAILimit

Events == {"openai", "anthropic"}
Histories == UNION {[1..length -> Events]: length \in 0..MaxLen}
CoarseStates == 0..MaxLen
FineStates == [openai: 0..MaxLen, anthropic: 0..MaxLen]

Uses(history, provider) ==
  Cardinality({index \in DOMAIN history: history[index] = provider})

Coarse(history) == Len(history)

Fine(history) ==
  [openai |-> Uses(history, "openai"),
   anthropic |-> Uses(history, "anthropic")]

ReduceCoarse(state, event) == state + 1

ReduceFine(state, event) ==
  IF event = "openai"
    THEN [state EXCEPT !.openai = @ + 1]
    ELSE [state EXCEPT !.anthropic = @ + 1]

Forget(fine) == fine.openai + fine.anthropic

GuessFine(coarse) ==
  [openai |-> coarse, anthropic |-> 0]

ObserveFine(state) == state.openai > OpenAILimit

NewOutcome(history) == Uses(history, "openai") > OpenAILimit

NewFutureEquivalent(left, right) ==
  \A suffix \in Histories:
    NewOutcome(left \o suffix) = NewOutcome(right \o suffix)

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

(* NewFactorization states that the new policy observes only the fine projection. *)
NewFactorization ==
  \A history \in Histories:
    NewOutcome(history) = ObserveFine(Fine(history))

(* CoarseReducerLaw states that total usage updates without replaying its prefix. *)
CoarseReducerLaw ==
  \A history \in Histories:
    \A event \in Events:
      Coarse(Append(history, event)) = ReduceCoarse(Coarse(history), event)

(* FineReducerLaw states that per-provider usage updates without replaying its prefix. *)
FineReducerLaw ==
  \A history \in Histories:
    \A event \in Events:
      Fine(Append(history, event)) = ReduceFine(Fine(history), event)

(* SafeCoarsening states that forgetting provider identity migrates every fine snapshot to the old total snapshot. *)
SafeCoarsening ==
  \A history \in Histories:
    Forget(Fine(history)) = Coarse(history)

(* CoarseningCommutes states that safe migration before or after one update produces the same coarse state. *)
CoarseningCommutes ==
  \A history \in Histories:
    \A event \in Events:
      Forget(ReduceFine(Fine(history), event))
      = ReduceCoarse(Forget(Fine(history)), event)

(* FineSufficient states that the new projection preserves every distinction required by the new policy. *)
FineSufficient ==
  \A left \in Histories:
    \A right \in Histories:
      Fine(left) = Fine(right) => NewFutureEquivalent(left, right)

FineMigrationSound(migration) ==
  \A history \in Histories:
    migration[Coarse(history)] = Fine(history)

(* NoFineMigration checks that no total-to-provider migration function is sound over the bounded history space. *)
NoFineMigration ==
  ~\E migration \in [CoarseStates -> FineStates]: FineMigrationSound(migration)

(* GuessMigrationSound claims that assigning all prior usage to OpenAI reconstructs every fine snapshot. An Anthropic history makes this claim false. *)
GuessMigrationSound ==
  GuessFine(Coarse(leftHistory)) = Fine(leftHistory)

(* CoarseSufficientForNew claims that equal total usage preserves every distinction required by the new policy. Provider-specific futures make this claim false. *)
CoarseSufficientForNew ==
  Coarse(leftHistory) = Coarse(rightHistory)
  => NewFutureEquivalent(leftHistory, rightHistory)

=============================================================================
