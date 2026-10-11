------------------------------- MODULE latest -------------------------------
(***************************************************************************)
(* Generation management of `latest` (../src/latest.ts), for one line     *)
(* (the root function or one fork; lines share no state).                 *)
(*                                                                         *)
(* Calls, cancels, and the settling of each call's function interleave in *)
(* every possible order. The wrapper's decision (deliver or Stale) runs as *)
(* its own step after the function settles, because in JS it is a         *)
(* microtask that other code may run before. Callers receive results      *)
(* through the microtask queue, which is FIFO.                            *)
(*                                                                         *)
(* Checked:                                                                *)
(*  - MatchesSpecWording: the generation counter, shared by call() and     *)
(*    cancel(), implements the spec's sentence "Stale if a newer call      *)
(*    exists", extended with "or the line was cancelled since it started". *)
(*  - ScreenNeverGoesBack: a caller that applies every non-Stale result in *)
(*    the order it receives them applies strictly increasing calls. This   *)
(*    holds for callers that act in their first continuation after        *)
(*    `await`; it needs FIFO delivery (set FifoDelivery = FALSE to see the *)
(*    counterexample).                                                     *)
(*  - EveryCallSettles: no call is left pending, so no awaiting caller    *)
(*    hangs and no rejection goes unobserved.                              *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS MaxCalls, MaxCancels, FifoDelivery

Ids == 1..MaxCalls
\* "throw" covers the AbortError a superseded or cancelled call rejects with.
Outcomes == {"ok", "err", "throw"}

VARIABLES
    calls,       \* calls started so far; call i is the i-th
    cancels,     \* cancel() invocations so far (bounded for model checking)
    generation,  \* the wrapper's counter: ++ on every call and every cancel
    gen,         \* gen[i]: the generation call i was given
    fn,          \* fn[i]: "idle" | "running" | an outcome | "decided"
    result,      \* result[i]: "none" | an outcome | "stale"
    expected,    \* expected[i]: result[i] per the spec's wording (history variable)
    cancelMark,  \* value of `calls` at the latest cancel(): calls <= it were cancelled
    queue,       \* call ids whose wrapper promise resolved, waiting for their caller
    applied      \* call ids whose non-Stale result a caller applied, in order

vars == <<calls, cancels, generation, gen, fn, result, expected, cancelMark, queue, applied>>

TypeOK ==
    /\ calls \in 0..MaxCalls
    /\ cancels \in 0..MaxCancels
    /\ generation \in 0..(MaxCalls + MaxCancels)
    /\ gen \in [Ids -> 0..(MaxCalls + MaxCancels)]
    /\ fn \in [Ids -> {"idle", "running", "decided"} \cup Outcomes]
    /\ result \in [Ids -> {"none", "stale"} \cup Outcomes]
    /\ expected \in [Ids -> {"none", "stale"} \cup Outcomes]
    /\ cancelMark \in 0..MaxCalls
    /\ queue \in Seq(Ids)
    /\ applied \in Seq(Ids)

Init ==
    /\ calls = 0
    /\ cancels = 0
    /\ generation = 0
    /\ gen = [i \in Ids |-> 0]
    /\ fn = [i \in Ids |-> "idle"]
    /\ result = [i \in Ids |-> "none"]
    /\ expected = [i \in Ids |-> "none"]
    /\ cancelMark = 0
    /\ queue = <<>>
    /\ applied = <<>>

\* call(...): gen = ++generation; the previous call's signal is aborted, which
\* only means that call's function may settle with "throw".
Call ==
    /\ calls < MaxCalls
    /\ LET i == calls + 1 IN
        /\ calls' = i
        /\ generation' = generation + 1
        /\ gen' = [gen EXCEPT ![i] = generation + 1]
        /\ fn' = [fn EXCEPT ![i] = "running"]
    /\ UNCHANGED <<cancels, result, expected, cancelMark, queue, applied>>

\* cancel(): generation++ and abort. Only forks have it; the root line never
\* takes this step, which removes behaviours and so preserves every property.
Cancel ==
    /\ cancels < MaxCancels
    /\ cancels' = cancels + 1
    /\ generation' = generation + 1
    /\ cancelMark' = calls
    /\ UNCHANGED <<calls, gen, fn, result, expected, queue, applied>>

\* The function's promise settles, in any order and with any outcome.
FnSettles(i) ==
    /\ fn[i] = "running"
    /\ \E o \in Outcomes : fn' = [fn EXCEPT ![i] = o]
    /\ UNCHANGED <<calls, cancels, generation, gen, result, expected, cancelMark, queue, applied>>

\* The wrapper's then-callback: `gen === generation ? outcome : STALE`.
Decide(i) ==
    /\ fn[i] \in Outcomes
    /\ fn' = [fn EXCEPT ![i] = "decided"]
    /\ result' = [result EXCEPT ![i] = IF gen[i] = generation THEN fn[i] ELSE "stale"]
    \* The spec's wording, stated without the counter.
    /\ expected' = [expected EXCEPT ![i] =
            IF calls = i /\ cancelMark < i THEN fn[i] ELSE "stale"]
    /\ queue' = Append(queue, i)
    /\ UNCHANGED <<calls, cancels, generation, gen, cancelMark, applied>>

\* A caller's continuation runs. A delivered "throw" lands in its catch block,
\* which updates the screen too, so it counts as applied.
Apply(k) ==
    /\ applied' = IF result[queue[k]] = "stale" THEN applied ELSE Append(applied, queue[k])
    /\ queue' = SubSeq(queue, 1, k - 1) \o SubSeq(queue, k + 1, Len(queue))
    /\ UNCHANGED <<calls, cancels, generation, gen, fn, result, expected, cancelMark>>

Deliver ==
    /\ queue # <<>>
    /\ IF FifoDelivery THEN Apply(1) ELSE \E k \in 1..Len(queue) : Apply(k)

Next ==
    \/ Call
    \/ Cancel
    \/ \E i \in Ids : FnSettles(i) \/ Decide(i)
    \/ Deliver

\* Every started function eventually settles (fetch resolves or is aborted).
Fairness ==
    /\ \A i \in Ids : WF_vars(FnSettles(i)) /\ WF_vars(Decide(i))
    /\ WF_vars(Deliver)

Spec == Init /\ [][Next]_vars /\ Fairness

MatchesSpecWording == \A i \in Ids : result[i] = expected[i]

ScreenNeverGoesBack == \A k \in 1..(Len(applied) - 1) : applied[k] < applied[k + 1]

EveryCallSettles == \A i \in Ids : (fn[i] = "running") ~> (fn[i] = "decided" /\ i \notin {queue[k] : k \in 1..Len(queue)})
=============================================================================
