---------------------------- MODULE chunkstream ----------------------------
(***************************************************************************)
(* The ordering of `ChunkStream` (../src/stream.ts).                       *)
(*                                                                         *)
(* A sender emits chunks 0..N-1 in order into a network that may reorder  *)
(* them (any copy in flight can arrive next), duplicate them and lose      *)
(* them. The stream delivers in sequence order, holds chunks that arrive   *)
(* early, and skips a gap either when its wait runs out (a step that may   *)
(* happen at any time, since timing is not modelled) or when more than     *)
(* MaxBuffer chunks are held. Chunks below the next expected number are    *)
(* dropped as duplicates or late arrivals.                                 *)
(*                                                                         *)
(* Checked:                                                                *)
(*  - Increasing: delivered numbers strictly increase, so none is          *)
(*    delivered twice and none goes backwards.                             *)
(*  - SkippedNeverDelivered: a chunk given up on is never delivered later. *)
(*  - NothingVanishes: every chunk sent is delivered, skipped, held,       *)
(*    still in flight, or was lost by the network.                         *)
(*  - CompleteWithoutSkips: once everything has arrived, if the network    *)
(*    lost nothing and no gap was skipped, all of 0..N-1 were delivered.   *)
(*  - HeldBounded: at most MaxBuffer chunks are held.                      *)
(* Set RejectOld = FALSE (chunkstream_accept_old.cfg) to see Increasing    *)
(* fail when old numbers are not dropped.                                  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS N, MaxBuffer, MaxDups, MaxLosses, RejectOld

Chunks == 0..(N - 1)

VARIABLES
    sent,       \* chunks emitted so far: 0..sent-1
    net,        \* net[m]: copies of chunk m in flight
    dups,       \* duplications so far (bounded for model checking)
    lost,       \* chunks the network lost a copy of
    expected,   \* the next number to deliver
    held,       \* chunks that arrived early
    skipped,    \* numbers given up on
    skips,      \* how many times a gap was skipped (wait or overflow)
    delivered   \* the numbers delivered, in order

vars == <<sent, net, dups, lost, expected, held, skipped, skips, delivered>>

Min(S) == CHOOSE x \in S : \A y \in S : x <= y

\* The first number from e on that is not held: delivery runs up to it.
RunEnd(e, h) == CHOOSE k \in e..N : (\A j \in e..(k - 1) : j \in h) /\ k \notin h

Numbers(from, to) == [i \in 1..(to - from) |-> from + i - 1]

Range(s) == {s[i] : i \in DOMAIN s}

TypeOK ==
    /\ sent \in 0..N
    /\ net \in [Chunks -> Nat]
    /\ lost \subseteq Chunks
    /\ expected \in 0..N
    /\ held \subseteq Chunks
    /\ skipped \subseteq Chunks
    /\ delivered \in Seq(Chunks)

Init ==
    /\ sent = 0
    /\ net = [m \in Chunks |-> 0]
    /\ dups = 0
    /\ lost = {}
    /\ expected = 0
    /\ held = {}
    /\ skipped = {}
    /\ skips = 0
    /\ delivered = <<>>

Send ==
    /\ sent < N
    /\ net' = [net EXCEPT ![sent] = @ + 1]
    /\ sent' = sent + 1
    /\ UNCHANGED <<dups, lost, expected, held, skipped, skips, delivered>>

Duplicate(m) ==
    /\ net[m] > 0 /\ dups < MaxDups
    /\ net' = [net EXCEPT ![m] = @ + 1]
    /\ dups' = dups + 1
    /\ UNCHANGED <<sent, lost, expected, held, skipped, skips, delivered>>

Lose(m) ==
    /\ net[m] > 0 /\ Cardinality(lost) < MaxLosses
    /\ net' = [net EXCEPT ![m] = @ - 1]
    /\ lost' = lost \cup {m}
    /\ UNCHANGED <<sent, dups, expected, held, skipped, skips, delivered>>

\* Gives up on expected..Min(h)-1 and delivers the run from Min(h).
SkipFrom(e, h) ==
    LET low == Min(h)
        end == RunEnd(low, h)
    IN  /\ skipped' = skipped \cup (e..(low - 1))
        /\ expected' = end
        /\ held' = h \ (low..(end - 1))
        /\ skips' = skips + 1
        /\ delivered' = delivered \o Numbers(low, end)

Receive(m) ==
    /\ net[m] > 0
    /\ net' = [net EXCEPT ![m] = @ - 1]
    /\ UNCHANGED <<sent, dups, lost>>
    /\ IF m < expected
       THEN IF RejectOld
            THEN UNCHANGED <<expected, held, skipped, skips, delivered>>   \* duplicate or late: dropped
            ELSE /\ delivered' = Append(delivered, m)                      \* the bug the check must catch
                 /\ UNCHANGED <<expected, held, skipped, skips>>
       ELSE IF m \in held
       THEN UNCHANGED <<expected, held, skipped, skips, delivered>>        \* duplicate of a held chunk
       ELSE LET h == held \cup {m}
                end == RunEnd(expected, h)
                rest == h \ (expected..(end - 1))
                run == delivered \o Numbers(expected, end)
            IN  IF Cardinality(rest) > MaxBuffer
                THEN \* overflow: deliver the run, then skip the oldest gap at once
                     LET low == Min(rest)
                         end2 == RunEnd(low, rest)
                     IN  /\ skipped' = skipped \cup (end..(low - 1))
                         /\ expected' = end2
                         /\ held' = rest \ (low..(end2 - 1))
                         /\ skips' = skips + 1
                         /\ delivered' = run \o Numbers(low, end2)
                ELSE /\ expected' = end
                     /\ held' = rest
                     /\ delivered' = run
                     /\ UNCHANGED <<skipped, skips>>

\* The wait for the gap runs out.
Timeout ==
    /\ held # {}
    /\ SkipFrom(expected, held)
    /\ UNCHANGED <<sent, net, dups, lost>>

Done ==
    /\ sent = N /\ \A m \in Chunks : net[m] = 0 /\ held = {}
    /\ UNCHANGED vars

Next ==
    \/ Send
    \/ \E m \in Chunks : Duplicate(m) \/ Lose(m) \/ Receive(m)
    \/ Timeout
    \/ Done

Spec == Init /\ [][Next]_vars

Increasing ==
    \A i, j \in DOMAIN delivered : i < j => delivered[i] < delivered[j]

SkippedNeverDelivered == Range(delivered) \cap skipped = {}

NothingVanishes ==
    \A m \in 0..(sent - 1) :
        m \in Range(delivered) \cup skipped \cup held \cup lost \/ net[m] > 0

CompleteWithoutSkips ==
    (sent = N /\ (\A m \in Chunks : net[m] = 0) /\ lost = {} /\ skips = 0)
        => delivered = Numbers(0, N)

HeldBounded == Cardinality(held) <= MaxBuffer

HeldAhead == \A m \in held : m > expected
=============================================================================
