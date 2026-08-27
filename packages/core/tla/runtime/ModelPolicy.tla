-------------------------- MODULE ModelPolicy --------------------------
(* ModelPolicy models provider and model identities as coordinates, a complete host policy, recursive authority attenuation, default overrides, and explicit selection. *)

EXTENDS FiniteSets, TLC

CONSTANTS Actors, Root, NoActor

(* CoordinateSpace is the normalized output of any selector or future query language. Policy composition depends only on these resolved coordinates. *)
CoordinateSpace == {<<"openai", "large">>, <<"openai", "small">>, <<"anthropic", "sonnet">>}
NoModel == <<"none", "none">>
HostConfigured == CoordinateSpace
HostAllowed == {<<"openai", "large">>, <<"openai", "small">>}
HostDefault == <<"openai", "large">>
HostAuthority == HostConfigured \cap HostAllowed
AllowDeclarations == SUBSET CoordinateSpace
DefaultDeclarations == CoordinateSpace \cup {NoModel}

ASSUME Root \in Actors
ASSUME HostConfigured \subseteq CoordinateSpace
ASSUME HostAllowed \subseteq CoordinateSpace
ASSUME HostDefault \in HostAuthority
ASSUME NoModel \notin CoordinateSpace
ASSUME NoActor \notin Actors

(* AllowSet interprets omission and allow = "*" as the full coordinate space supplied by the caller. *)
AllowSet(declared) == declared

(* Attenuate intersects a layer's selector set with its incoming authority. *)
Attenuate(incoming, declared) == incoming \cap AllowSet(declared)

(* DefaultOf inherits the incoming default unless the layer declares another coordinate. *)
DefaultOf(incoming, declared) == IF declared = NoModel THEN incoming ELSE declared

VARIABLES active, parent, localAllow, localDefault, effective, defaults, attempted, selected, outcome

vars == <<active, parent, localAllow, localDefault, effective, defaults, attempted, selected, outcome>>

TypeOK ==
  /\ active \subseteq Actors
  /\ Root \in active
  /\ parent \in [Actors -> Actors \cup {NoActor}]
  /\ localAllow \in [Actors -> SUBSET CoordinateSpace]
  /\ localDefault \in [Actors -> DefaultDeclarations]
  /\ effective \in [Actors -> SUBSET CoordinateSpace]
  /\ defaults \in [Actors -> DefaultDeclarations]
  /\ attempted \in [Actors -> DefaultDeclarations]
  /\ selected \in [Actors -> DefaultDeclarations]
  /\ outcome \in [Actors -> {"pending", "selected", "failed"}]

(* Init applies an optional root actor policy to the complete host policy. Invalid root policies produce no initial state. *)
Init ==
  \E declaredAllow \in AllowDeclarations, declaredDefault \in DefaultDeclarations:
    LET rootAuthority == Attenuate(HostAuthority, declaredAllow)
        rootDefault == DefaultOf(HostDefault, declaredDefault)
    IN /\ rootDefault \in rootAuthority
       /\ active = {Root}
       /\ parent = [actor \in Actors |-> NoActor]
       /\ localAllow = [actor \in Actors |-> IF actor = Root THEN AllowSet(declaredAllow) ELSE CoordinateSpace]
       /\ localDefault = [actor \in Actors |-> IF actor = Root THEN declaredDefault ELSE NoModel]
       /\ effective = [actor \in Actors |-> IF actor = Root THEN rootAuthority ELSE {}]
       /\ defaults = [actor \in Actors |-> IF actor = Root THEN rootDefault ELSE NoModel]
       /\ attempted = [actor \in Actors |-> NoModel]
       /\ selected = [actor \in Actors |-> NoModel]
       /\ outcome = [actor \in Actors |-> "pending"]

(* Spawn intersects a child's optional selector with parent authority and resolves its optional default. The membership guard rejects a narrowing that excludes the resolved default. *)
Spawn(child, source, declaredAllow, declaredDefault) ==
  LET childAuthority == Attenuate(effective[source], declaredAllow)
      childDefault == DefaultOf(defaults[source], declaredDefault)
  IN /\ child \notin active
     /\ source \in active
     /\ declaredAllow \in AllowDeclarations
     /\ declaredDefault \in DefaultDeclarations
     /\ childDefault \in childAuthority
     /\ active' = active \cup {child}
     /\ parent' = [parent EXCEPT ![child] = source]
     /\ localAllow' = [localAllow EXCEPT ![child] = AllowSet(declaredAllow)]
     /\ localDefault' = [localDefault EXCEPT ![child] = declaredDefault]
     /\ effective' = [effective EXCEPT ![child] = childAuthority]
     /\ defaults' = [defaults EXCEPT ![child] = childDefault]
     /\ UNCHANGED <<attempted, selected, outcome>>

(* Attempt records an authorized coordinate or a durable rejection. *)
Attempt(actor, coordinate) ==
  /\ actor \in active
  /\ outcome[actor] = "pending"
  /\ coordinate \in CoordinateSpace
  /\ attempted' = [attempted EXCEPT ![actor] = coordinate]
  /\ IF coordinate \in effective[actor]
     THEN /\ selected' = [selected EXCEPT ![actor] = coordinate]
          /\ outcome' = [outcome EXCEPT ![actor] = "selected"]
     ELSE /\ selected' = selected
          /\ outcome' = [outcome EXCEPT ![actor] = "failed"]
  /\ UNCHANGED <<active, parent, localAllow, localDefault, effective, defaults>>

(* ResolveDefault selects the effective policy's distinguished coordinate. *)
ResolveDefault(actor) == Attempt(actor, defaults[actor])

Next ==
  \/ \E child \in Actors, source \in Actors, declaredAllow \in AllowDeclarations, declaredDefault \in DefaultDeclarations:
       Spawn(child, source, declaredAllow, declaredDefault)
  \/ \E actor \in Actors, coordinate \in CoordinateSpace: Attempt(actor, coordinate)
  \/ \E actor \in Actors: ResolveDefault(actor)

Spec == Init /\ [][Next]_vars

(* PolicyDefinition states that every actor is the intersection of its incoming authority and local selector, with an inherited or overridden default. *)
PolicyDefinition ==
  /\ effective[Root] = HostAuthority \cap localAllow[Root]
  /\ defaults[Root] = DefaultOf(HostDefault, localDefault[Root])
  /\ \A actor \in active \ {Root}:
       /\ parent[actor] \in active
       /\ effective[actor] = effective[parent[actor]] \cap localAllow[actor]
       /\ defaults[actor] = DefaultOf(defaults[parent[actor]], localDefault[actor])

(* ChildCannotWiden states that every child remains within its parent's authority. *)
ChildCannotWiden ==
  \A actor \in active \ {Root}: effective[actor] \subseteq effective[parent[actor]]

(* HostCeiling states that every actor remains within the configured and allowed host coordinates. *)
HostCeiling ==
  \A actor \in active: effective[actor] \subseteq HostAuthority

(* DefaultAllowed states that every active policy has a distinguished coordinate inside its authority. *)
DefaultAllowed ==
  \A actor \in active: defaults[actor] \in effective[actor]

(* SelectionRequiresAuthority states that every selected coordinate belongs to the actor's effective set. *)
SelectionRequiresAuthority ==
  \A actor \in active: selected[actor] # NoModel => selected[actor] \in effective[actor]

(* DeniedAttemptFails states that a denied coordinate terminates without selection. *)
DeniedAttemptFails ==
  \A actor \in active:
    attempted[actor] # NoModel /\ attempted[actor] \notin effective[actor] => outcome[actor] = "failed" /\ selected[actor] = NoModel

(* TrustSpawn replaces attenuation with a child's selector set. ModelPolicyWiden.cfg demonstrates the resulting authority amplification. *)
TrustSpawn(child, source, declaredAllow, declaredDefault) ==
  LET childAuthority == AllowSet(declaredAllow)
      childDefault == DefaultOf(defaults[source], declaredDefault)
  IN /\ child \notin active
     /\ source \in active
     /\ declaredAllow \in AllowDeclarations
     /\ declaredDefault \in DefaultDeclarations
     /\ childDefault \in childAuthority
     /\ active' = active \cup {child}
     /\ parent' = [parent EXCEPT ![child] = source]
     /\ localAllow' = [localAllow EXCEPT ![child] = AllowSet(declaredAllow)]
     /\ localDefault' = [localDefault EXCEPT ![child] = declaredDefault]
     /\ effective' = [effective EXCEPT ![child] = childAuthority]
     /\ defaults' = [defaults EXCEPT ![child] = childDefault]
     /\ UNCHANGED <<attempted, selected, outcome>>

TrustNext ==
  \E child \in Actors, source \in Actors, declaredAllow \in AllowDeclarations, declaredDefault \in DefaultDeclarations:
    TrustSpawn(child, source, declaredAllow, declaredDefault)

TrustSpec == Init /\ [][TrustNext]_vars

=============================================================================
