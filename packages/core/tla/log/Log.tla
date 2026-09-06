------------------------------- MODULE Log -------------------------------
(* The ground: an immutable append-only sequence of events. Append is the
   only mutation the whole system has. There is nothing to prove here; the
   module exists so every other module names the same vocabulary.

   An event here is an abstract value. What events MEAN is a reactor's
   business (Projection.tla interprets them; Reconcile.tla acts on them);
   the log itself is meaning-free. *)

EXTENDS Naturals, Sequences

(* The prefix up to and including position i. Position 0 is the empty log.
   Every projection in the suite is a function of some prefix; the doctrine
   (Projection.tla) is about WHICH prefix an interpretation may depend on. *)
Prefix(log, i) == SubSeq(log, 1, i)

=======================================================================
