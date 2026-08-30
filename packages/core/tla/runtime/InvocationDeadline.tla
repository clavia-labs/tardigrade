------------------------ MODULE InvocationDeadline ------------------------
(* InvocationDeadline models a child call bounded by its parent and local deadlines. *)

EXTENDS Integers, TLC

CONSTANTS ParentDeadline, LocalDeadline

VARIABLE childDeadline

vars == <<childDeadline>>

Init == childDeadline = 0

Min(left, right) == IF left <= right THEN left ELSE right

Plan ==
  /\ childDeadline = 0
  /\ childDeadline' = Min(ParentDeadline, LocalDeadline)

PlanLocalOnly ==
  /\ childDeadline = 0
  /\ childDeadline' = LocalDeadline

Spec == Init /\ [][Plan]_vars
SpecLocalOnly == Init /\ [][PlanLocalOnly]_vars

ChildBoundedByParent == childDeadline = 0 \/ childDeadline <= ParentDeadline

=============================================================================
