---------------------------- MODULE ImageBatch -----------------------------
EXTENDS Integers, Sequences, FiniteSets, TLC

\* Legacy code and a PROPOSED protocol share transport/Steam actions. This file
\* does not implement the proposal. See README.md for the atomic boundaries.
CONSTANTS ImageCount, OrderedBatch, SerialRead, PreparedInOrder, Healthy, AllowRestart,
          ReleaseUnknown, ReplayUnknown, CancelCommitAsUnsent, SkipCancelDrain,
          SkipMissing, RetainDependencies
Images == 1..ImageCount
InputOrder == [i \in Images |-> i]
Terminal == {"sent", "cancelled", "failed", "unknown"}

VARIABLES read, http, arrived, registration, reserved, live, loaded, state,
          wire, running, attempts, faulted, actual, badGate, restarted, stopped, network
vars == <<read, http, arrived, registration, reserved, live, loaded, state,
          wire, running, attempts, faulted, actual, badGate, restarted, stopped, network>>

Init ==
    /\ read = {} /\ http = {} /\ arrived = {} /\ registration = <<>>
    /\ reserved = FALSE /\ live = {} /\ loaded = {}
    /\ state = [i \in Images |-> "absent"]
    /\ wire = [i \in Images |-> "idle"]
    /\ running = {} /\ attempts = [i \in Images |-> 0]
    /\ faulted = {} /\ actual = <<>> /\ badGate = FALSE
    /\ restarted = [occurred |-> FALSE, acceptedCount |-> 0] /\ stopped = FALSE
    /\ network = [pending |-> {}, cancelledDrained |-> {}]

\* Candidate protocol: register the immutable ordered membership BEFORE any
\* member can be activated. A repeat of this reservation has no side effects.
ReserveBatch ==
    /\ OrderedBatch /\ ~reserved /\ ~stopped
    /\ reserved' = TRUE /\ registration' = InputOrder /\ live' = Images
    /\ state' = [i \in Images |-> "prepared"]
    /\ UNCHANGED <<read, http, arrived, loaded, wire, running, attempts,
                   faulted, actual, badGate, restarted, stopped, network>>

ReadFile(i) ==
    /\ i \notin read
    /\ ~SerialRead \/ (\A j \in Images : j < i => j \in read)
    /\ read' = read \cup {i}
    \* Legacy FileReader.onload immediately invokes sendImage synchronously.
    /\ http' = IF ~OrderedBatch /\ ~stopped THEN http \cup {i} ELSE http
    /\ UNCHANGED <<arrived, registration, reserved, live, loaded, state,
                   wire, running, attempts, faulted, actual, badGate,
                   restarted, stopped, network>>

SendHttp(i) ==
    /\ i \in read /\ i \notin http /\ ~stopped
    /\ ~OrderedBatch \/ reserved
    /\ http' = http \cup {i}
    /\ UNCHANGED <<read, arrived, registration, reserved, live, loaded,
                   state, wire, running, attempts, faulted, actual,
                   badGate, restarted, stopped, network>>

\* File reads, HTTP arrival, validation/loading completion are independent.
\* Legacy /upload creates a task when the per-image body reaches the server;
\* two-stage clients can create before loading, but cannot enforce Steam order.
Arrive(i) ==
    /\ i \in http /\ i \notin arrived /\ ~stopped
    /\ ~OrderedBatch \/ (i \in live /\ state[i] = "prepared")
    /\ ~PreparedInOrder \/ (\A j \in Images : j < i => j \in arrived)
    /\ arrived' = arrived \cup {i}
    /\ registration' = IF OrderedBatch THEN registration ELSE Append(registration, i)
    /\ live' = live \cup {i}
    /\ state' = [state EXCEPT ![i] = "prepared"]
    /\ UNCHANGED <<read, http, reserved, loaded, wire, running, attempts,
                   faulted, actual, badGate, restarted, stopped, network>>

LoadImage(i) ==
    /\ i \in arrived /\ i \in live /\ i \notin loaded
    /\ state[i] = "prepared" /\ ~stopped
    /\ ~PreparedInOrder \/ (\A j \in Images : j < i => j \in loaded)
    /\ loaded' = loaded \cup {i}
    /\ state' = [state EXCEPT ![i] = "queued"]
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live,
                   wire, running, attempts, faulted, actual, badGate,
                   restarted, stopped, network>>

\* Only a confirmed success or an explicit precommit cancellation with all
\* transport drained releases a position. Missing state is NOT confirmation.
Reliable(j) == j \in live /\
    (state[j] = "sent" \/ (state[j] = "cancelled" /\ wire[j] = "idle"
        /\ ~\E a \in 1..2 : <<j, a>> \in network.pending))
Gate(i) == ~OrderedBatch \/ (\A j \in Images : j < i =>
    IF j \notin live THEN SkipMissing
    ELSE state[j] = "sent"
      \/ (state[j] = "cancelled" /\ (CancelCommitAsUnsent \/ SkipCancelDrain \/ wire[j] = "idle"))
      \/ (ReleaseUnknown /\ state[j] = "unknown"))
Eligible(i) == i \in live /\ i \in loaded
    /\ state[i] \in {"queued", "retry"} /\ wire[i] = "idle"
    /\ attempts[i] < 2 /\ Gate(i)
EarlierInMap(j, i) == \E p, q \in 1..Len(registration) :
    p < q /\ registration[p] = j /\ registration[q] = i
Occupied == {i \in Images : i \in running \/ wire[i] # "idle"}

\* Match pump's Map insertion scan and per-account two-slot bound. In the
\* ordered proposal, only the batch head whose predecessors are released can
\* enter this adapter; unrelated batches/chats are outside this model.
Start(i) ==
    /\ ~stopped /\ Eligible(i) /\ Cardinality(Occupied) < 2
    /\ ~\E j \in Images : EarlierInMap(j, i) /\ Eligible(j)
    /\ state' = [state EXCEPT ![i] = "running"]
    /\ wire' = [wire EXCEPT ![i] = "upload"]
    /\ attempts' = [attempts EXCEPT ![i] = @ + 1]
    /\ running' = running \cup {i}
    /\ badGate' = (badGate \/ (OrderedBatch /\
                         (\E j \in Images : j < i /\ ~Reliable(j))))
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live, loaded,
                   faulted, actual, restarted, stopped, network>>

IssueCommit(i) ==
    /\ i \in live /\ state[i] = "running" /\ wire[i] = "upload" /\ ~stopped
    /\ wire' = [wire EXCEPT ![i] = "commit"]
    /\ network' = [network EXCEPT !.pending = @ \cup {<<i, attempts[i]>>}]
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live, loaded,
                   state, running, attempts, faulted, actual, badGate,
                   restarted, stopped>>

\* Local callbacks can finish while the request is still on its way to Steam.
\* Remote outstanding commits are independent of local wire/transport state.
Accept(i, a) ==
    /\ <<i, a>> \in network.pending
    /\ network' = [network EXCEPT !.pending = @ \ {<<i, a>>}]
    /\ wire' = IF a = attempts[i] /\ wire[i] = "commit"
               THEN [wire EXCEPT ![i] = "accepted"] ELSE wire
    /\ actual' = Append(actual, i)
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live, loaded,
                   state, running, attempts, faulted, badGate, restarted, stopped>>

Ack(i) ==
    /\ wire[i] = "accepted" /\ i \in live /\ ~stopped
    /\ state[i] \in {"running", "unknown"}
    /\ wire' = [wire EXCEPT ![i] = "idle"]
    /\ state' = [state EXCEPT ![i] = "sent"]
    /\ running' = running \ {i}
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live, loaded,
                   attempts, faulted, actual, badGate, restarted, stopped, network>>

LoseAck(i) ==
    /\ ~Healthy /\ wire[i] = "accepted" /\ i \in live /\ ~stopped
    /\ state[i] \in {"running", "unknown", "cancelled"}
    /\ wire' = [wire EXCEPT ![i] = "idle"]
    /\ state' = [state EXCEPT ![i] = IF @ = "cancelled" THEN @ ELSE "unknown"]
    /\ running' = running \ {i}
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live, loaded,
                   attempts, faulted, actual, badGate, restarted, stopped, network>>

Timeout(i) ==
    /\ ~Healthy /\ i \in live /\ state[i] = "running" /\ wire[i] = "commit"
    /\ state' = [state EXCEPT ![i] = "unknown"]
    /\ running' = running \ {i}
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live, loaded,
                   wire, attempts, faulted, actual, badGate, restarted, stopped, network>>

\* A network error drains the LOCAL pending promise. It does not withdraw an
\* already issued remote commit. Unknown may now be garbage-collected.
TransportError(i) ==
    /\ ~Healthy /\ i \in live /\ ~stopped
    /\ state[i] \in {"running", "unknown"} /\ wire[i] = "commit"
    /\ state' = [state EXCEPT ![i] = "unknown"]
    /\ wire' = [wire EXCEPT ![i] = "idle"]
    /\ running' = running \ {i}
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live, loaded,
                   attempts, faulted, actual, badGate, restarted, stopped, network>>

\* A definite precommit failure can retry. Only one injected transient failure
\* per item keeps the space finite without claiming a particular delay bound.
FailBeforeCommit(i) ==
    /\ ~Healthy /\ state[i] = "running" /\ wire[i] = "upload"
    /\ i \notin faulted /\ ~stopped
    /\ \E outcome \in {"retry", "failed"} : state' = [state EXCEPT ![i] = outcome]
    /\ wire' = [wire EXCEPT ![i] = "idle"]
    /\ faulted' = faulted \cup {i} /\ running' = running \ {i}
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live, loaded,
                   attempts, actual, badGate, restarted, stopped, network>>

Cancel(i) ==
    /\ ~Healthy /\ i \in live /\ ~stopped
    /\ state[i] \in {"prepared", "queued", "retry", "failed", "running"}
    /\ state' = [state EXCEPT ![i] =
         IF wire[i] \in {"commit", "accepted"} /\ ~CancelCommitAsUnsent
         THEN "unknown" ELSE "cancelled"]
    /\ running' = running \ {i}
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live, loaded,
                   wire, attempts, faulted, actual, badGate, restarted, stopped, network>>

\* Precommit abort must be observed by the adapter before any commit. It is
\* not enough to stop waiting. Underlying upload callbacks may drain late.
DrainCancelled(i) ==
    /\ state[i] = "cancelled" /\ wire[i] = "upload"
    /\ wire' = [wire EXCEPT ![i] = "idle"]
    /\ network' = [network EXCEPT !.cancelledDrained = @ \cup {i}]
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live, loaded,
                   state, running, attempts, faulted, actual, badGate,
                   restarted, stopped>>

\* Mutation: replaying an unknown request after its lost acknowledgement has
\* drained can create a second accepted copy, even with ordered dispatch.
RetryUnknown(i) ==
    /\ ReplayUnknown /\ ~stopped /\ i \in live
    /\ state[i] = "unknown" /\ wire[i] = "idle" /\ attempts[i] < 2
    /\ state' = [state EXCEPT ![i] = "retry"]
    /\ UNCHANGED <<read, http, arrived, registration, reserved, live, loaded,
                   wire, running, attempts, faulted, actual, badGate,
                   restarted, stopped, network>>

\* Proposed dependency records stay retained while any later item still needs
\* them. Expiration never becomes an implicit successful/skip receipt.
Expire(i) ==
    /\ ~Healthy /\ i \in live /\ wire[i] = "idle" /\ ~stopped
    /\ state[i] \in Terminal
    /\ ~RetainDependencies \/ ~OrderedBatch \/
         (\A j \in Images : j > i => state[j] \in {"sent", "cancelled"})
    /\ live' = live \ {i}
    /\ UNCHANGED <<read, http, arrived, registration, reserved, loaded, state,
                   wire, running, attempts, faulted, actual, badGate,
                   restarted, stopped, network>>

\* CANDIDATE ASSUMPTION: restart invalidates old batches; their identities must
\* not be recreated. Current /upload can recreate a missing client ID, so this
\* is a future API obligation, NOT a verified property of current production.
Restart ==
    /\ AllowRestart /\ ~restarted.occurred
    /\ restarted' = [occurred |-> TRUE, acceptedCount |-> Len(actual)]
    /\ stopped' = TRUE /\ live' = {} /\ running' = {}
    /\ UNCHANGED <<read, http, arrived, registration, reserved, loaded, state,
                   wire, attempts, faulted, actual, badGate, network>>

Next == ReserveBatch \/ Restart \/ (\E i \in Images :
    ReadFile(i) \/ SendHttp(i) \/ Arrive(i) \/ LoadImage(i) \/ Start(i)
    \/ IssueCommit(i) \/ (\E a \in 1..2 : Accept(i, a)) \/ Ack(i) \/ LoseAck(i) \/ Timeout(i)
    \/ TransportError(i)
    \/ FailBeforeCommit(i) \/ Cancel(i) \/ DrainCancelled(i) \/ Expire(i) \/ RetryUnknown(i))
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(ReserveBatch) /\
    (\A i \in Images : WF_vars(ReadFile(i)) /\ WF_vars(SendHttp(i))
      /\ WF_vars(Arrive(i)) /\ WF_vars(LoadImage(i)) /\ WF_vars(Start(i))
      /\ WF_vars(IssueCommit(i)) /\ (\A a \in 1..2 : WF_vars(Accept(i, a))) /\ WF_vars(Ack(i)))

TypeOK ==
    /\ read \subseteq Images /\ http \subseteq read /\ arrived \subseteq http
    /\ loaded \subseteq arrived /\ live \subseteq Images
    /\ registration \in Seq(Images) /\ Len(registration) <= ImageCount
    /\ state \in [Images -> {"absent", "prepared", "queued", "running",
                            "retry", "failed", "unknown", "cancelled", "sent"}]
    /\ wire \in [Images -> {"idle", "upload", "commit", "accepted"}]
    /\ running \subseteq Images /\ attempts \in [Images -> 0..2]
    /\ faulted \subseteq Images /\ actual \in Seq(Images)
    /\ reserved \in BOOLEAN /\ badGate \in BOOLEAN
    /\ restarted \in [occurred : BOOLEAN, acceptedCount : 0..(2 * ImageCount)]
    /\ stopped \in BOOLEAN
    /\ network \in [pending : SUBSET (Images \X (1..2)), cancelledDrained : SUBSET Images]
AcceptedInInputOrder == \A p, q \in 1..Len(actual) : p < q => actual[p] < actual[q]
NoDuplicateAccept == \A i \in Images : Cardinality({p \in 1..Len(actual) : actual[p] = i}) <= 1
NoSilentRelease == ~badGate
ImmutableRegistration == OrderedBatch /\ reserved => registration = InputOrder
ConfirmedMeansAccepted == \A i \in Images : state[i] = "sent" =>
    \E p \in 1..Len(actual) : actual[p] = i
EventuallyAllSent == <>(\A i \in Images : state[i] = "sent")

\* Intentionally violated sentinels prove nontrivial paths are reachable.
NotAllSent == ~(\A i \in Images : state[i] = "sent")
NotReverseRead == ~(ImageCount \in read /\ 1 \notin read)
NotUnknownBlocking == ~(state[1] = "unknown" /\ state[2] = "queued" /\ attempts[2] = 0)
NotRetryThenSent == ~(state[1] = "sent" /\ attempts[1] = 2)
NotSafeSkipThenSent == ~(state[1] = "cancelled" /\ 1 \in network.cancelledDrained /\ state[2] = "sent")
NotLateAcceptAfterRestart == ~(stopped /\ Len(actual) > restarted.acceptedCount)
=============================================================================
