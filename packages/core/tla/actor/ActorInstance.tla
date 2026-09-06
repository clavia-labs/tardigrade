---------------------------- MODULE ActorInstance ----------------------------
(* ActorInstance models the durable isolation boundary between an actor definition and its thread trees. An address is <<actor, instance, thread>>. Root activation derives instance from authenticated subject ownership. Child activation inherits actor and instance from its parent. Object placement, directory listing, encryption-key availability, and revocation all use the complete address. *)

EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Actors, Instances, Threads, Subjects, ActorName, RootThread, ChildThread,
          AuthorizedInstance, RequestedInstance, ForeignInstance, ObjectOf, KeyOf

Addresses == Actors \X Instances \X Threads

ASSUME ActorName \in Actors
ASSUME RootThread \in Threads
ASSUME ChildThread \in Threads
ASSUME RootThread # ChildThread
ASSUME AuthorizedInstance \in [Subjects -> Instances]
ASSUME RequestedInstance \in [Subjects -> Instances]
ASSUME ForeignInstance \in [Instances -> Instances]
ASSUME DOMAIN ObjectOf = Addresses
ASSUME DOMAIN KeyOf = Addresses
ASSUME \A left \in Subjects, right \in Subjects:
  AuthorizedInstance[left] = AuthorizedInstance[right] => left = right
ASSUME \A instance \in Instances: ForeignInstance[instance] # instance

ModelActors == {"research"}
ModelInstances == {"alice", "bob"}
ModelThreads == {"root", "child"}
ModelSubjects == {"subject-a", "subject-b"}
ModelAuthorizedInstance == [subject \in ModelSubjects |->
  CASE subject = "subject-a" -> "alice"
    [] OTHER -> "bob"]
ModelRequestedInstance == [subject \in ModelSubjects |->
  CASE subject = "subject-a" -> "bob"
    [] OTHER -> "alice"]
ModelForeignInstance == [instance \in ModelInstances |->
  CASE instance = "alice" -> "bob"
    [] OTHER -> "alice"]
ModelAddresses == ModelActors \X ModelInstances \X ModelThreads
ModelObjectOf == [address \in ModelAddresses |-> <<"object", address>>]
ModelObjectWithoutInstance == [address \in ModelAddresses |-> <<"object", address[1], address[3]>>]
ModelKeyOf == [address \in ModelAddresses |-> <<"key", address>>]
ModelKeyWithoutInstance == [address \in ModelAddresses |-> <<"key", address[1], address[3]>>]

RootAddress(subject) == <<ActorName, AuthorizedInstance[subject], RootThread>>
RequestedRootAddress(subject) == <<ActorName, RequestedInstance[subject], RootThread>>
ChildAddress(parent) == <<parent[1], parent[2], ChildThread>>
EscapedChildAddress(parent) == <<parent[1], ForeignInstance[parent[2]], ChildThread>>
InstanceOf(address) == address[2]

VARIABLES requestedRoots, acceptedRoots, requestedChildren, parentEdges,
          active, directory, routed, requestedLists, completedLists, listings,
          revokedInstances, availableKeys

vars == <<requestedRoots, acceptedRoots, requestedChildren, parentEdges,
          active, directory, routed, requestedLists, completedLists, listings,
          revokedInstances, availableKeys>>

AcceptedSubject(subject) == \E address \in Addresses: <<subject, address>> \in acceptedRoots

TypeOK ==
  /\ requestedRoots \subseteq Subjects
  /\ acceptedRoots \subseteq Subjects \X Addresses
  /\ requestedChildren \subseteq Addresses
  /\ parentEdges \subseteq Addresses \X Addresses
  /\ active \subseteq Addresses
  /\ directory \subseteq Addresses
  /\ routed \subseteq {<<address, ObjectOf[address]>> : address \in Addresses}
  /\ requestedLists \subseteq Subjects
  /\ completedLists \subseteq Subjects
  /\ listings \subseteq Subjects \X Addresses
  /\ revokedInstances \subseteq Instances
  /\ availableKeys \subseteq {KeyOf[address] : address \in Addresses}

Init ==
  /\ requestedRoots = {}
  /\ acceptedRoots = {}
  /\ requestedChildren = {}
  /\ parentEdges = {}
  /\ active = {}
  /\ directory = {}
  /\ routed = {}
  /\ requestedLists = {}
  /\ completedLists = {}
  /\ listings = {}
  /\ revokedInstances = {}
  /\ availableKeys = {}

RequestRoot(subject) ==
  /\ subject \notin requestedRoots
  /\ AuthorizedInstance[subject] \notin revokedInstances
  /\ requestedRoots' = requestedRoots \cup {subject}
  /\ UNCHANGED <<acceptedRoots, requestedChildren, parentEdges, active, directory,
                  routed, requestedLists, completedLists, listings,
                  revokedInstances, availableKeys>>

ActivateRoot(subject) ==
  LET address == RootAddress(subject)
  IN
    /\ subject \in requestedRoots
    /\ ~AcceptedSubject(subject)
    /\ InstanceOf(address) \notin revokedInstances
    /\ acceptedRoots' = acceptedRoots \cup {<<subject, address>>}
    /\ active' = active \cup {address}
    /\ directory' = directory \cup {address}
    /\ routed' = routed \cup {<<address, ObjectOf[address]>>}
    /\ availableKeys' = availableKeys \cup {KeyOf[address]}
    /\ UNCHANGED <<requestedRoots, requestedChildren, parentEdges,
                    requestedLists, completedLists, listings, revokedInstances>>

ActivateRequestedRoot(subject) ==
  LET address == RequestedRootAddress(subject)
  IN
    /\ subject \in requestedRoots
    /\ ~AcceptedSubject(subject)
    /\ InstanceOf(address) \notin revokedInstances
    /\ acceptedRoots' = acceptedRoots \cup {<<subject, address>>}
    /\ active' = active \cup {address}
    /\ directory' = directory \cup {address}
    /\ routed' = routed \cup {<<address, ObjectOf[address]>>}
    /\ availableKeys' = availableKeys \cup {KeyOf[address]}
    /\ UNCHANGED <<requestedRoots, requestedChildren, parentEdges,
                    requestedLists, completedLists, listings, revokedInstances>>

RequestChild(parent) ==
  LET child == ChildAddress(parent)
  IN
    /\ parent \in active
    /\ parent[3] = RootThread
    /\ parent \notin requestedChildren
    /\ child \notin active
    /\ InstanceOf(parent) \notin revokedInstances
    /\ requestedChildren' = requestedChildren \cup {parent}
    /\ UNCHANGED <<requestedRoots, acceptedRoots, parentEdges, active, directory,
                    routed, requestedLists, completedLists, listings,
                    revokedInstances, availableKeys>>

ActivateChild(parent) ==
  LET child == ChildAddress(parent)
  IN
    /\ parent \in requestedChildren
    /\ child \notin active
    /\ InstanceOf(parent) \notin revokedInstances
    /\ parentEdges' = parentEdges \cup {<<parent, child>>}
    /\ active' = active \cup {child}
    /\ directory' = directory \cup {child}
    /\ routed' = routed \cup {<<child, ObjectOf[child]>>}
    /\ availableKeys' = availableKeys \cup {KeyOf[child]}
    /\ UNCHANGED <<requestedRoots, acceptedRoots, requestedChildren,
                    requestedLists, completedLists, listings, revokedInstances>>

ActivateEscapedChild(parent) ==
  LET child == EscapedChildAddress(parent)
  IN
    /\ parent \in requestedChildren
    /\ child \notin active
    /\ InstanceOf(parent) \notin revokedInstances
    /\ parentEdges' = parentEdges \cup {<<parent, child>>}
    /\ active' = active \cup {child}
    /\ directory' = directory \cup {child}
    /\ routed' = routed \cup {<<child, ObjectOf[child]>>}
    /\ availableKeys' = availableKeys \cup {KeyOf[child]}
    /\ UNCHANGED <<requestedRoots, acceptedRoots, requestedChildren,
                    requestedLists, completedLists, listings, revokedInstances>>

RequestList(subject) ==
  /\ subject \notin requestedLists
  /\ requestedLists' = requestedLists \cup {subject}
  /\ UNCHANGED <<requestedRoots, acceptedRoots, requestedChildren, parentEdges,
                  active, directory, routed, completedLists, listings,
                  revokedInstances, availableKeys>>

CompleteList(subject) ==
  /\ subject \in requestedLists
  /\ subject \notin completedLists
  /\ completedLists' = completedLists \cup {subject}
  /\ listings' = listings \cup
       {<<subject, address>> : address \in
         {item \in directory: InstanceOf(item) = AuthorizedInstance[subject]}}
  /\ UNCHANGED <<requestedRoots, acceptedRoots, requestedChildren, parentEdges,
                  active, directory, routed, requestedLists,
                  revokedInstances, availableKeys>>

CompleteGlobalList(subject) ==
  /\ subject \in requestedLists
  /\ subject \notin completedLists
  /\ completedLists' = completedLists \cup {subject}
  /\ listings' = listings \cup {<<subject, address>> : address \in directory}
  /\ UNCHANGED <<requestedRoots, acceptedRoots, requestedChildren, parentEdges,
                  active, directory, routed, requestedLists,
                  revokedInstances, availableKeys>>

Revoke(instance) ==
  /\ instance \notin revokedInstances
  /\ revokedInstances' = revokedInstances \cup {instance}
  /\ directory' = {address \in directory: InstanceOf(address) # instance}
  /\ listings' = {entry \in listings: InstanceOf(entry[2]) # instance}
  /\ availableKeys' = availableKeys \
       {KeyOf[address] : address \in
         {item \in active: InstanceOf(item) = instance}}
  /\ UNCHANGED <<requestedRoots, acceptedRoots, requestedChildren, parentEdges,
                  active, routed, requestedLists, completedLists>>

CorrectNext ==
  \/ \E subject \in Subjects: RequestRoot(subject)
  \/ \E subject \in Subjects: ActivateRoot(subject)
  \/ \E parent \in Addresses: RequestChild(parent)
  \/ \E parent \in Addresses: ActivateChild(parent)
  \/ \E subject \in Subjects: RequestList(subject)
  \/ \E subject \in Subjects: CompleteList(subject)
  \/ \E instance \in Instances: Revoke(instance)

AuthorityNext ==
  \/ \E subject \in Subjects: RequestRoot(subject)
  \/ \E subject \in Subjects: ActivateRequestedRoot(subject)

ChildEscapeNext ==
  \/ \E subject \in Subjects: RequestRoot(subject)
  \/ \E subject \in Subjects: ActivateRoot(subject)
  \/ \E parent \in Addresses: RequestChild(parent)
  \/ \E parent \in Addresses: ActivateEscapedChild(parent)

GlobalListNext ==
  \/ \E subject \in Subjects: RequestRoot(subject)
  \/ \E subject \in Subjects: ActivateRoot(subject)
  \/ \E subject \in Subjects: RequestList(subject)
  \/ \E subject \in Subjects: CompleteGlobalList(subject)

Spec == Init /\ [][CorrectNext]_vars
AuthoritySpec == Init /\ [][AuthorityNext]_vars
ChildEscapeSpec == Init /\ [][ChildEscapeNext]_vars
GlobalListSpec == Init /\ [][GlobalListNext]_vars

LiveSpec ==
  /\ Spec
  /\ \A subject \in Subjects: WF_vars(RequestRoot(subject))
  /\ \A subject \in Subjects: WF_vars(ActivateRoot(subject))
  /\ \A parent \in Addresses: WF_vars(RequestChild(parent))
  /\ \A parent \in Addresses: WF_vars(ActivateChild(parent))
  /\ \A subject \in Subjects: WF_vars(RequestList(subject))
  /\ \A subject \in Subjects: WF_vars(CompleteList(subject))

AcceptedAuthorized ==
  \A subject \in Subjects, address \in Addresses:
    <<subject, address>> \in acceptedRoots => InstanceOf(address) = AuthorizedInstance[subject]

ChildInheritsInstance ==
  \A parent \in Addresses, child \in Addresses:
    <<parent, child>> \in parentEdges =>
      parent[1] = child[1] /\ InstanceOf(parent) = InstanceOf(child)

RoutedObjectIsolation ==
  \A left \in Addresses, right \in Addresses:
    <<left, ObjectOf[left]>> \in routed /\
      <<right, ObjectOf[left]>> \in routed => left = right

ListingIsolation ==
  \A subject \in Subjects, address \in Addresses:
    <<subject, address>> \in listings => InstanceOf(address) = AuthorizedInstance[subject]

DirectoryIsActive == directory \subseteq active

DirectoryExcludesRevoked ==
  \A address \in directory: InstanceOf(address) \notin revokedInstances

LiveKeysRemain ==
  \A address \in active:
    InstanceOf(address) \notin revokedInstances => KeyOf[address] \in availableKeys

RevokedKeysDisappear ==
  \A address \in active:
    InstanceOf(address) \in revokedInstances => KeyOf[address] \notin availableKeys

RootRequestsSettle ==
  \A subject \in Subjects:
    subject \in requestedRoots ~>
      AcceptedSubject(subject) \/ AuthorizedInstance[subject] \in revokedInstances

ChildRequestsSettle ==
  \A parent \in Addresses:
    parent \in requestedChildren ~>
      ChildAddress(parent) \in active \/ InstanceOf(parent) \in revokedInstances

ListRequestsSettle ==
  \A subject \in Subjects:
    subject \in requestedLists ~> subject \in completedLists

=============================================================================
