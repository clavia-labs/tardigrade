----------------------- MODULE TransitionDeclarations -----------------------
EXTENDS Naturals, FiniteSets

(* TransitionDeclarations separates logical objects from their declared strings so UniqueRefs can detect aliasing (TransitionDeclarations.cfg). TransitionIdentity.tla checks downstream completion and replay behavior once references are unique. *)
CONSTANTS ComponentSlots, TransitionSlots, Names, Tags, MaxOwners, MaxNoise,
          MaxDeclarations, CheckNames, CheckTags, SharedNamespace, StableTagsAcrossOutputs
ASSUME /\ Names \subseteq (STRING \ {""})
       /\ Tags \subseteq (STRING \ {""})

VARIABLES nextSeq, owners, noise, components, declarations, offered
vars == <<nextSeq, owners, noise, components, declarations, offered>>
Kinds == {"intent", "effect"}

Init ==
  /\ nextSeq = 1
  /\ owners = {}
  /\ noise = 0
  /\ components = {}
  /\ declarations = {}
  /\ offered = {}

AppendOwner ==
  /\ Cardinality(owners) < MaxOwners
  /\ owners' = owners \cup {nextSeq}
  /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED <<noise, components, declarations, offered>>

AppendNoise ==
  /\ noise < MaxNoise
  /\ noise' = noise + 1
  /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED <<owners, components, declarations, offered>>

(* DeclareComponent binds a logical component slot to an immutable declared string. CheckNames enforces uniqueness across the composition. *)
DeclareComponent(slot, name) ==
  /\ ~\E c \in components : c.slot = slot
  /\ CheckNames => ~\E c \in components : c.name = name
  /\ components' = components \cup {[slot |-> slot, name |-> name]}
  /\ UNCHANGED <<nextSeq, owners, noise, declarations, offered>>

(* RuntimeAllows models the duplicate check within the current output. Intent and effect tags share a namespace when SharedNamespace is TRUE (src/transition/transition.ts, validateTransitions). *)
RuntimeAllows(owner, component, kind, tag) ==
  CheckTags => ~\E d \in offered :
    /\ d.owner = owner /\ d.component = component /\ d.tag = tag
    /\ SharedNamespace \/ d.kind = kind

(* AuthorAllows states the stable-tag contract across outputs; the runtime does not retain this history. A different logical slot cannot acquire the tag of a declaration absent from the current output. Simultaneous declarations are checked separately by RuntimeAllows. *)
AuthorAllows(owner, component, tag) ==
  StableTagsAcrossOutputs => ~\E d \in declarations \ offered :
    d.owner = owner /\ d.component = component /\ d.tag = tag

(* Declare introduces a new logical operation, keeping its slot independent of its physical reference. Repeated offers of that operation use Reoffer. *)
Declare(owner, component, slot, kind, tag) ==
  /\ Cardinality(declarations) < MaxDeclarations
  /\ ~\E d \in declarations :
       d.owner = owner /\ d.component = component /\ d.slot = slot
  /\ RuntimeAllows(owner, component, kind, tag)
  /\ AuthorAllows(owner, component, tag)
  /\ LET declaration == [owner |-> owner, component |-> component,
                          slot |-> slot, kind |-> kind, tag |-> tag]
     IN /\ declarations' = declarations \cup {declaration}
        /\ offered' = offered \cup {declaration}
  /\ UNCHANGED <<nextSeq, owners, noise, components>>

(* NextOutput clears the runtime's duplicate set after a state update or replay; the logical history remains available only to the specification. Completion and retry behavior are modeled in TransitionIdentity.tla and runtime/transition-lifecycle.properties.test.ts. *)
NextOutput ==
  /\ offered # {}
  /\ offered' = {}
  /\ UNCHANGED <<nextSeq, owners, noise, components, declarations>>

(* Reoffer preserves an existing operation's identity across outputs without treating it as a new declaration. Inputs and action bodies are outside the identity model and may vary between offers (runtime/transition-lifecycle.properties.test.ts). *)
Reoffer(d) ==
  /\ d \notin offered
  /\ RuntimeAllows(d.owner, d.component, d.kind, d.tag)
  /\ offered' = offered \cup {d}
  /\ UNCHANGED <<nextSeq, owners, noise, components, declarations>>

Next ==
  \/ AppendOwner
  \/ AppendNoise
  \/ NextOutput
  \/ \E d \in declarations : Reoffer(d)
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
  /\ offered \subseteq declarations

ComponentSlotsUnique == \A a, b \in components : a.slot = b.slot => a = b
ComponentNamesUnique == \A a, b \in components : a.name = b.name => a = b
LocalTagsUnique == \A a, b \in declarations :
  (a.owner = b.owner /\ a.component = b.component /\ a.tag = b.tag) => a = b

(* UniqueRefs follows for arbitrary finite bounds when CheckNames, CheckTags, SharedNamespace, and StableTagsAcrossOutputs are TRUE. The induction invariant is TypeOK /\ ComponentSlotsUnique /\ ComponentNamesUnique /\ LocalTagsUnique. Init satisfies it on empty sets. AppendOwner uses a fresh position; AppendNoise changes no declarations. DeclareComponent preserves component uniqueness through its guards. For Declare, every prior declaration is either offered or absent from offered. RuntimeAllows excludes a same-ref declaration in offered; AuthorAllows excludes one in declarations \ offered. Together they preserve LocalTagsUnique. NextOutput and Reoffer change no logical declarations. This argument explicitly depends on an author contract in addition to runtime checks (TransitionDeclarationsTagReuse.cfg removes only that contract). *)

(* UniqueRefs then follows by extensional equality: let a and b be declarations with equal references. Tuple equality gives equal owners, equal component names, and equal tags. ComponentSlotsUnique makes ComponentName well-defined; ComponentNamesUnique gives a.component = b.component. LocalTagsUnique now gives a = b. Conversely, a = b gives equal references by substitution. Therefore two declarations have the same reference exactly when they are the same logical transition, and replay of that transition preserves its reference. The proof is written here; TLC checks the configured finite instances, without mechanically checking this general induction argument. *)

=============================================================================
