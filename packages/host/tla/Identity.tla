----------------------------- MODULE Identity -----------------------------
(* Identity models host allocation and core invocation coordinates; Identity.cfg checks separation and retry stability. *)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Nodes, Scope, Parent, Local, Tokens, None, Fault

ModelNodes == {"root", "peer", "child", "sibling", "grandchild", "tenant", "actor"}
ModelScope == [n \in ModelNodes |->
  CASE n = "tenant" -> <<"tardie", "morty">>
    [] n = "actor" -> <<"other", "rick">>
    [] OTHER -> <<"tardie", "rick">>]
ModelParent == [n \in ModelNodes |->
  CASE n = "child" -> "root"
    [] n = "sibling" -> "peer"
    [] n = "grandchild" -> "child"
    [] OTHER -> "none"]
ModelLocal == [n \in ModelNodes |-> IF n = "peer" THEN <<"name", "lab">> ELSE <<"name", "main">>]
ModelKeyLocal == [n \in ModelNodes |-> IF n = "peer" THEN <<"key", "main">> ELSE <<"name", "main">>]

ASSUME /\ Parent \in [Nodes -> Nodes \cup {None}]
       /\ None \notin Tokens
       /\ \A n \in Nodes: Parent[n] # None => Scope[n] = Scope[Parent[n]]
       /\ \A left, right \in Nodes:
            <<Scope[left], Parent[left], Local[left]>> = <<Scope[right], Parent[right], Local[right]>> => left = right

VARIABLES assigned, returned
vars == <<assigned, returned>>
Init == /\ assigned = [n \in Nodes |-> None]
        /\ returned = [n \in Nodes |-> {}]

Address(n, token) == <<Scope[n][1], Scope[n][2], token>>
Ready(n) == IF Parent[n] = None THEN TRUE ELSE assigned[Parent[n]] # None
Key(n) == IF Parent[n] = None
          THEN <<"root", Scope[n], Local[n]>>
          ELSE <<"child", Scope[n], IF Fault = "parent" THEN None ELSE assigned[Parent[n]], Local[n]>>
Allocated == {n \in Nodes: assigned[n] # None}
Available(n, token) == \A other \in Allocated:
  Address(n, token) # Address(other, assigned[other])

(* Claim abstracts the atomic read, collision check, and ThreadAllocated append in allocation-sql.ts. *)
Claim(n) ==
  /\ Ready(n)
  /\ assigned[n] = None
  /\ LET existing == {other \in Allocated: Key(other) = Key(n)}
     IN IF existing # {}
        THEN LET other == CHOOSE other \in existing: TRUE
             IN /\ assigned' = [assigned EXCEPT ![n] = assigned[other]]
                /\ returned' = [returned EXCEPT ![n] = @ \cup {Address(n, assigned[other])}]
        ELSE \E token \in Tokens:
          /\ Fault = "collision" \/ Available(n, token)
          /\ assigned' = [assigned EXCEPT ![n] = token]
          /\ returned' = [returned EXCEPT ![n] = @ \cup {Address(n, token)}]

(* Retry models a request after a restart; the directory assignment survives the lost caller state. *)
Retry(n) ==
  /\ n \in Allocated
  /\ IF Fault = "retry"
     THEN \E token \in Tokens:
       /\ token # assigned[n]
       /\ assigned' = [assigned EXCEPT ![n] = token]
       /\ returned' = [returned EXCEPT ![n] = @ \cup {Address(n, token)}]
     ELSE /\ UNCHANGED assigned
          /\ returned' = [returned EXCEPT ![n] = @ \cup {Address(n, assigned[n])}]

Next == \E n \in Nodes: Claim(n) \/ Retry(n)
Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ \A n \in Nodes: WF_vars(Claim(n))

TypeOK == /\ assigned \in [Nodes -> Tokens \cup {None}]
          /\ \A n \in Nodes: returned[n] \subseteq {Address(n, token): token \in Tokens}
ThreadSeparation == Cardinality({Address(n, assigned[n]): n \in Allocated}) = Cardinality(Allocated)
RetryStable == \A n \in Nodes: Cardinality(returned[n]) <= 1
ParentDistinct == \A n \in Allocated: Parent[n] # None => assigned[n] # assigned[Parent[n]]
AllAllocated == <> (Allocated = Nodes)

(* InvocationSpace represents locally unique method, id, and epoch tuples supplied at each thread. *)
InvocationSpace == Allocated \X {"message", "inspect"} \X {"first", "second"} \X {0, 1}
Ref(i) == <<IF Fault = "target" THEN None ELSE Address(i[1], assigned[i[1]]), i[2], i[3], i[4]>>
InvocationSeparation == Cardinality({Ref(i): i \in InvocationSpace}) = Cardinality(InvocationSpace)

(* CallId follows invocationIdForKey in core/src/interaction/invocation.ts; tuples abstract injective JSON encoding. *)
CallSpace == InvocationSpace \X {"call-0", "call-1"}
CallId(c) == <<"invocation", IF Fault = "caller" THEN None ELSE Ref(c[1]), c[2]>>
CallSeparation == Cardinality({CallId(c): c \in CallSpace}) = Cardinality(CallSpace)
=============================================================================
