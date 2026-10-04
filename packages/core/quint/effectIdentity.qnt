// effectIdentity models fresh (seq, atom, act) allocation with per-sequence duplicate rejection (uniqueReferences).
// The namespace contains two atoms and two acts; positions and transition counts are unbounded.
// The observer remembers an arbitrary earlier allocation and checks subsequent allocations for collision.
// Replay is assumed to preserve existing references; execution, settlement, and TypeScript refinement are outside this model.
// Quint 0.32.0 with Apalache 0.56.1 checks initialization, inductive preservation, and implication of uniqueReferences.
// Run from the repository root; verifier output stays in a temporary directory:
// quint typecheck packages/core/quint/effectIdentity.qnt
// identity_model="$PWD/packages/core/quint/effectIdentity.qnt"
// verification_dir=$(mktemp -d /tmp/tardigrade-quint.XXXXXX)
// (cd "$verification_dir" && JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home quint verify "$identity_model" --inductive-invariant=invariant --invariants uniqueReferences --verbosity=2)

module effectIdentity {
  type Key = (str, str)
  type Ref = { seq: int, atom: str, act: str }

  pure val atoms = Set("model", "tool")
  pure val acts = Set("call", "other")
  pure val operationKeys = tuples(atoms, acts)

  var position: int
  var allocatedHere: Set[Key]
  var remembered: int
  var rememberedSeq: int
  var rememberedKey: Key
  var collision: int

  def reference(seq: int, key: Key): Ref = { seq: seq, atom: key._1, act: key._2 }

  action init = all {
    position' = 0,
    allocatedHere' = Set(),
    remembered' = 0,
    rememberedSeq' = 0,
    rememberedKey' = ("model", "call"),
    collision' = 0,
  }

  // allocate checks each fresh allocation against an arbitrarily remembered earlier allocation.
  action allocate(key: Key, remember: bool): bool = all {
    not(allocatedHere.contains(key)),
    allocatedHere' = allocatedHere.union(Set(key)),
    collision' = if (remembered == 1 and reference(position, key) == reference(rememberedSeq, rememberedKey)) 1 else collision,
    remembered' = if (remember) 1 else remembered,
    rememberedSeq' = if (remember) position else rememberedSeq,
    rememberedKey' = if (remember) key else rememberedKey,
    position' = position,
  }

  action advance = all {
    position' = position + 1,
    allocatedHere' = Set(),
    remembered' = remembered,
    rememberedSeq' = rememberedSeq,
    rememberedKey' = rememberedKey,
    collision' = collision,
  }

  // reuse covers observation and replay of an existing allocation without creating fresh work.
  action reuse = all {
    position' = position,
    allocatedHere' = allocatedHere,
    remembered' = remembered,
    rememberedSeq' = rememberedSeq,
    rememberedKey' = rememberedKey,
    collision' = collision,
  }

  action step = {
    nondet key = operationKeys.oneOf()
    nondet remember = Set(false, true).oneOf()
    any { allocate(key, remember), advance, reuse }
  }

  val uniqueReferences = collision == 0

  val invariant = all {
    position.in(Nat),
    allocatedHere.in(operationKeys.powerset()),
    remembered.in(0.to(1)),
    rememberedSeq.in(Nat),
    rememberedKey.in(operationKeys),
    collision == 0,
    rememberedSeq <= position,
    (remembered == 1 and rememberedSeq == position) implies allocatedHere.contains(rememberedKey),
  }
}
