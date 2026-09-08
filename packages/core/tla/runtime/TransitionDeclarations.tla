----------------------- MODULE TransitionDeclarations -----------------------
EXTENDS Naturals, FiniteSets

(* TransitionDeclarations separates logical objects from their declared strings so UniqueRefs can detect aliasing (TransitionDeclarations.cfg). TransitionIdentity.tla checks downstream completion and replay behavior once references are unique. *)
CONSTANTS ComponentSlots, TransitionSlots, Names, Tags, MaxOwners, MaxNoise,
          MaxDeclarations, CheckNames, CheckTags, SharedNamespace
ASSUME /\ Names \subseteq (STRING \ {""})
       /\ Tags \subseteq (STRING \ {""})

VARIABLES nextSeq, owners, noise, components, declarations
vars == <<nextSeq, owners, noise, components, declarations>>
Kinds == {"intent", "effect"}

Init ==
  /\ nextSeq = 1
  /\ owners = {}
  /\ noise = 0
  /\ components = {}
  /\ declarations = {}

AppendOwner ==
  /\ Cardinality(owners) < MaxOwners
  /\ owners' = owners \cup {nextSeq}
  /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED <<noise, components, declarations>>

AppendNoise ==
  /\ noise < MaxNoise
  /\ noise' = noise + 1
  /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED <<owners, components, declarations>>

(* DeclareComponent binds a logical component slot to an immutable declared string. CheckNames enforces uniqueness across the composition. *)
DeclareComponent(slot, name) ==
  /\ ~\E c \in components : c.slot = slot
  /\ CheckNames => ~\E c \in components : c.name = name
  /\ components' = components \cup {[slot |-> slot, name |-> name]}
  /\ UNCHANGED <<nextSeq, owners, noise, declarations>>

(* Declare binds a logical transition slot to a stable tag for its owner's lifetime. SharedNamespace makes intents and effects participate in the same duplicate check. Completed declarations are retained here because completing an obligation does not permit its tag to name a different obligation. *)
Declare(owner, component, slot, kind, tag) ==
  /\ Cardinality(declarations) < MaxDeclarations
  /\ ~\E d \in declarations :
       /\ d.owner = owner /\ d.component = component /\ d.slot = slot
  /\ CheckTags => ~\E d \in declarations :
       /\ d.owner = owner /\ d.component = component /\ d.tag = tag
       /\ SharedNamespace \/ d.kind = kind
  /\ declarations' = declarations \cup {
       [owner |-> owner, component |-> component, slot |-> slot, kind |-> kind, tag |-> tag]}
  /\ UNCHANGED <<nextSeq, owners, noise, components>>

Next ==
  \/ AppendOwner
  \/ AppendNoise
  \/ \E s \in ComponentSlots, n \in Names : DeclareComponent(s, n)
  \/ \E o \in owners, c \in {x.slot : x \in components},
        s \in TransitionSlots, k \in Kinds, t \in Tags : Declare(o, c, s, k, t)
Spec == Init /\ [][Next]_vars

ComponentName(slot) == (CHOOSE c \in components : c.slot = slot).name
TransitionRef(d) == <<d.owner, ComponentName(d.component), d.tag>>
UniqueRefs == \A a, b \in declarations : TransitionRef(a) = TransitionRef(b) => a = b

TypeOK ==
  /\ nextSeq = 1 + Cardinality(owners) + noise
  /\ owners \subseteq 1..(nextSeq - 1)
  /\ Cardinality(owners) <= MaxOwners
  /\ noise \in 0..MaxNoise
  /\ components \subseteq [slot : ComponentSlots, name : Names]
  /\ declarations \subseteq [owner : owners, component : {c.slot : c \in components},
                              slot : TransitionSlots, kind : Kinds, tag : Tags]
  /\ Cardinality(declarations) <= MaxDeclarations

ComponentSlotsUnique == \A a, b \in components : a.slot = b.slot => a = b
ComponentNamesUnique == \A a, b \in components : a.name = b.name => a = b
LocalTagsUnique == \A a, b \in declarations :
  (a.owner = b.owner /\ a.component = b.component /\ a.tag = b.tag) => a = b

(* UniqueRefs follows for arbitrary finite bounds when CheckNames, CheckTags, and SharedNamespace are TRUE. The induction invariant is TypeOK /\ ComponentSlotsUnique /\ ComponentNamesUnique /\ LocalTagsUnique. Init satisfies it on empty sets. AppendOwner uses nextSeq greater than every prior owner position; AppendNoise changes no declarations. DeclareComponent preserves the two component uniqueness predicates through its slot and name guards and cannot change existing names. Declare preserves LocalTagsUnique through its owner/component/tag guard, independent of kind. Existing declarations are immutable. These facts also preserve the invariant under stuttering and establish it for every finite prefix of Spec. *)

(* UniqueRefs then follows by extensional equality: let a and b be declarations with equal references. Tuple equality gives equal owners, equal component names, and equal tags. ComponentSlotsUnique makes ComponentName well-defined; ComponentNamesUnique gives a.component = b.component. LocalTagsUnique now gives a = b. Conversely, a = b gives equal references by substitution. Therefore two declarations have the same reference exactly when they are the same logical transition, and replay of that transition preserves its reference. The proof is written here; TLC checks the configured finite instances, without mechanically checking this general induction argument. *)

=============================================================================
