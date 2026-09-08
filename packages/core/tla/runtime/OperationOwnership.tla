------------------------- MODULE OperationOwnership -------------------------
EXTENDS Naturals, FiniteSets

(* OperationOwnership models a durably admitted operation family. Admission is
   assumed to record identity and ownership atomically. Refs are scoped to a
   thread/log; payload IDs deliberately collide. It abstracts external actions,
   ingress validation, and allocation. TLC checks this bounded graph, not the
   TypeScript implementation. *)
CONSTANTS ExactRefs, KeepBackgroundOwner, TraverseCompleted, Fair
Ops == {"rootA", "rootB", "effectA", "effectB", "child"}
None == "none"
Parent(o) == CASE o = "effectA" -> "rootA"
               [] o = "effectB" -> "rootB"
               [] o = "child" -> "effectA"
               [] OTHER -> None
Ref(o) == CASE o = "rootA" -> <<"invocation", "threadA", "message", "same", 0>>
            [] o = "rootB" -> <<"invocation", "threadB", "message", "same", 0>>
            [] o = "effectA" -> <<"transition", "threadA", 12, "code", "execute">>
            [] o = "effectB" -> <<"transition", "threadA", 19, "code", "execute">>
            [] OTHER -> <<"invocation", "childThread", "message", "same", 0>>
Key(o) == IF ExactRefs THEN Ref(o) ELSE <<"same">>
ExpectedOwners == [o \in Ops |-> IF Parent(o) = None THEN <<>> ELSE Ref(Parent(o))]

VARIABLES owners, completed, cancelled, receipts, resolved
vars == <<owners, completed, cancelled, receipts, resolved>>
Children(nodes, traverse) == {o \in Ops : \E p \in nodes :
  owners[o] = Ref(p) /\ (traverse \/ p \notin completed)}
Family(root, traverse) ==
  LET one == {root} \cup Children({root}, traverse)
      two == one \cup Children(one, traverse)
  IN two \cup Children(two, traverse)
ExpectedFamily(root) == CASE root = "rootA" -> {"rootA", "effectA", "child"}
                         [] root = "effectA" -> {"effectA", "child"}
                         [] root = "rootB" -> {"rootB", "effectB"}
                         [] OTHER -> {root}

Init ==
  /\ owners = [o \in Ops |-> IF o = "child" /\ ~KeepBackgroundOwner
                              THEN <<>> ELSE ExpectedOwners[o]]
  /\ completed = {} /\ cancelled = {} /\ receipts = {} /\ resolved = {}

Finish(o) ==
  /\ o \notin completed \cup cancelled
  /\ completed' = completed \cup {o}
  /\ receipts' = receipts \cup {[operation |-> o, ref |-> Key(o)]}
  /\ resolved' = {p \in Ops : \E r \in receipts' : r.ref = Key(p)}
  /\ UNCHANGED <<owners, cancelled>>

Cancel(o) ==
  /\ o \notin cancelled
  /\ cancelled' = cancelled \cup Family(o, TraverseCompleted)
  /\ UNCHANGED <<owners, completed, receipts, resolved>>

Next == (\E o \in Ops : Finish(o)) \/ (\E o \in Ops : Cancel(o))
Spec == Init /\ [][Next]_vars /\
  (IF Fair THEN \A o \in Ops : WF_vars(Finish(o)) ELSE TRUE)

TypeOK == /\ owners \in [Ops -> ({<<>>} \cup {Ref(o) : o \in Ops})]
          /\ completed \subseteq Ops /\ cancelled \subseteq Ops /\ resolved \subseteq Ops
          /\ receipts \subseteq [operation : Ops, ref : {Key(o) : o \in Ops}]
UniqueIdentity == \A a, b \in Ops : Key(a) = Key(b) => a = b
OwnershipComplete == owners = ExpectedOwners
ExactResolution == resolved = {r.operation : r \in receipts}
CancellationClosure == \A o \in cancelled : ExpectedFamily(o) \subseteq cancelled
AllSettled == <>(completed \cup cancelled = Ops)
=============================================================================
