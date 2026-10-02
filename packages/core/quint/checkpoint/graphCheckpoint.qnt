// graphCheckpoint models topological composition of recovered durable values (graphEquivalent).
// Equal durable inputs are assumed from atomCheckpoint.qnt; projections share their configuration across both paths.
// Every extension chooses arbitrary existing parents and a Boolean truth table, allowing branches, joins, and shared dependencies.
// The finite instance contains two durable roots and up to two derived nodes; TypeScript refinement is outside this model.
// Quint 0.32.0 with Apalache 0.56.1 checks initialization, inductive preservation, and implication of graphEquivalent.
// Run verification in a temporary directory to keep checker artifacts outside the repository:
// graph_model="$PWD/packages/core/quint/checkpoint/graphCheckpoint.qnt"
// verification_dir=$(mktemp -d /tmp/tardigrade-quint-graph.XXXXXX)
// (cd "$verification_dir" && JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home quint verify "$graph_model" --inductive-invariant=invariant --invariants graphEquivalent)
module graphCheckpoint {
  pure val capacity = 4
  pure val values = Set(false, true)
  pure val inputs = tuples(values, values)
  pure val tables = inputs.powerset()
  pure val histories = 1.to(capacity).fold(Set(List()), (prefixes, _) =>
    prefixes.union(prefixes.fold(Set(List()), (output, prefix) =>
      output.union(values.map(value => prefix.append(value))))))

  var fullReplay: List[bool]
  var restored: List[bool]

  // project represents an arbitrary deterministic binary Boolean projection by its true input pairs.
  pure def project(table: Set[(bool, bool)], left: bool, right: bool): bool = table.contains((left, right))

  action init = {
    nondet roots = inputs.oneOf()
    all {
      fullReplay' = List(roots._1, roots._2),
      restored' = List(roots._1, roots._2),
    }
  }

  // compose extends the DAG with dependencies restricted to earlier nodes.
  action compose = {
    nondet left = fullReplay.indices().oneOf()
    nondet right = fullReplay.indices().oneOf()
    nondet table = tables.oneOf()
    all {
      fullReplay.length() < capacity,
      fullReplay' = fullReplay.append(project(table, fullReplay.nth(left), fullReplay.nth(right))),
      restored' = restored.append(project(table, restored.nth(left), restored.nth(right))),
    }
  }

  action observe = all { fullReplay' = fullReplay, restored' = restored }
  action step = any { compose, observe }

  val graphEquivalent = restored == fullReplay
  val invariant = all {
    fullReplay.in(histories), restored.in(histories),
    fullReplay.length() >= 2,
    graphEquivalent,
  }
}
