------------------------------ MODULE TextSend ------------------------------
EXTENDS Integers, FiniteSets, TLC

\* This is the LEGACY text UI protocol retained for counterexamples. See README.md for
\* source mappings, omitted behavior, and the meaning of the observer variables.
CONSTANTS Scenario, AutoReplay, MatchAll, EmptyMeansFailed

Locals == {1, 2}
Events == {1, 2, 3}
\* Events 1/2 originate at local attempts 1/2; 3 is an official-client send.
\* Origin is an observer fact: the matcher MUST NOT use it.
Origin(e) == IF e = 3 THEN 0 ELSE e

VARIABLES now, ui, present, startAt, calls, pending, accepted, eventAt,
          history, claimed, echo, parent, rejected, replied,
          badAssociation, consumers, checked, stuckCheck

vars == <<now, ui, present, startAt, calls, pending, accepted, eventAt,
          history, claimed, echo, parent, rejected, replied,
          badAssociation, consumers, checked, stuckCheck>>

Init ==
    /\ now = 0
    /\ ui = [a \in Locals |-> "absent"]
    /\ present = {}
    /\ startAt = [a \in Locals |-> 0]
    /\ calls = [a \in Locals |-> 0]
    /\ pending = {}
    /\ accepted = {}
    /\ eventAt = [e \in Events |-> 0]
    /\ history = {}
    /\ claimed = {}
    /\ echo = [a \in Locals |-> 0]
    /\ parent = [a \in Locals |-> 0]
    /\ rejected = {}
    /\ replied = {}
    /\ badAssociation = FALSE
    /\ consumers = [e \in Events |-> {}]
    /\ checked = FALSE
    /\ stuckCheck = FALSE

Begin(a) ==
    /\ ui[a] = "absent"
    /\ a = 1 \/ (Scenario = "all" /\ ui[1] # "absent")
    /\ ui' = [ui EXCEPT ![a] = "sending"]
    /\ present' = present \cup {a}
    /\ startAt' = [startAt EXCEPT ![a] = now]
    /\ UNCHANGED <<now, calls, pending, accepted, eventAt, history, claimed,
                   echo, parent, rejected, replied, badAssociation, consumers,
                   checked, stuckCheck>>

\* Begin includes dispatching the browser's HTTP request. Submit counts the
\* SERVER'S SDK invocation, which can wait until after the browser times out.
\* Each slot denotes ONE local attempt. A user retry after definite rejection
\* is a new attempt and is outside this bounded model. The mutation permits an
\* automatic second RPC for an unknown attempt, which must be detected.
Submit(a) ==
    /\ ui[a] # "absent"
    /\ (ui[a] \in {"sending", "unknown"} /\ calls[a] = 0)
       \/ (AutoReplay /\ ui[a] = "unknown" /\ calls[a] = 1)
    /\ calls' = [calls EXCEPT ![a] = @ + 1]
    /\ pending' = pending \cup {a}
    /\ UNCHANGED <<now, ui, present, startAt, accepted, eventAt, history,
                   claimed, echo, parent, rejected, replied, badAssociation,
                   consumers, checked, stuckCheck>>

\* Steam acceptance, browser observation, and history visibility are separate.
SteamAccept(a) ==
    /\ a \in pending /\ a \notin accepted /\ a \notin rejected
    /\ Scenario # "late" \/ now = 31
    /\ pending' = pending \ {a}
    /\ accepted' = accepted \cup {a}
    /\ eventAt' = [eventAt EXCEPT ![a] = now]
    /\ UNCHANGED <<now, ui, present, startAt, calls, history, claimed, echo,
                   parent, rejected, replied, badAssociation, consumers,
                   checked, stuckCheck>>

SteamReject(a) ==
    /\ a \in pending /\ a \notin accepted /\ calls[a] = 1
    /\ pending' = pending \ {a}
    /\ rejected' = rejected \cup {a}
    /\ UNCHANGED <<now, ui, present, startAt, calls, accepted, eventAt,
                   history, claimed, echo, parent, replied, badAssociation,
                   consumers, checked, stuckCheck>>

\* An HTTP/SDK timeout cannot cancel a pending Steam request. An uncertain
\* error may also arrive after Steam accepted, or after history was received.
ObserveUnknown(a) ==
    /\ ui[a] = "sending" /\ a \notin replied
    /\ ui' = [ui EXCEPT ![a] = "unknown"]
    /\ present' = IF echo[a] # 0 THEN present \ {a} ELSE present
    /\ replied' = replied \cup {a}
    /\ UNCHANGED <<now, startAt, calls, pending, accepted, eventAt, history,
                   claimed, echo, parent, rejected, badAssociation, consumers,
                   checked, stuckCheck>>

ObserveRejection(a) ==
    /\ ui[a] = "sending" /\ a \in rejected /\ a \notin replied
    /\ ui' = [ui EXCEPT ![a] = "failed"]
    /\ echo' = [echo EXCEPT ![a] = 0]
    /\ replied' = replied \cup {a}
    /\ UNCHANGED <<now, present, startAt, calls, pending, accepted, eventAt,
                   history, claimed, parent, rejected, badAssociation,
                   consumers, checked, stuckCheck>>

\* A direct successful HTTP response has a request-correlated identity.
ObserveSuccess(a) ==
    /\ ui[a] = "sending" /\ a \in accepted /\ a \notin replied
    /\ ui' = [ui EXCEPT ![a] = "sent"]
    /\ present' = present \ {a}
    /\ replied' = replied \cup {a}
    /\ claimed' = claimed \cup {a}
    /\ history' = history \cup {a}
    /\ UNCHANGED <<now, startAt, calls, pending, accepted, eventAt,
                   echo, parent, rejected, badAssociation, consumers,
                   checked, stuckCheck>>

ExplicitReplacement ==
    /\ Scenario \in {"all", "replacement"}
    /\ 1 \in present /\ ui[1] = "unknown" /\ ui[2] = "absent"
    /\ ui' = [ui EXCEPT ![2] = "sending"]
    /\ present' = present \cup {2}
    /\ startAt' = [startAt EXCEPT ![2] = now]
    /\ parent' = [parent EXCEPT ![2] = 1]
    /\ UNCHANGED <<now, calls, pending, accepted, eventAt, history, claimed,
                   echo, rejected, replied, badAssociation, consumers,
                   checked, stuckCheck>>

ExternalAccept ==
    /\ Scenario \in {"all", "external"} /\ 3 \notin accepted
    /\ accepted' = accepted \cup {3}
    /\ eventAt' = [eventAt EXCEPT ![3] = now]
    /\ UNCHANGED <<now, ui, present, startAt, calls, pending, history,
                   claimed, echo, parent, rejected, replied, badAssociation,
                   consumers, checked, stuckCheck>>

\* Same account, peer, normalized body and context are fixed for this model.
\* These are precisely the ambiguous cases; neither timestamp nor eventId
\* contains a local request identity. Failed entries are never matched.
Eligible(e) == {a \in present : ui[a] # "failed" /\ echo[a] = 0
                 /\ eventAt[e] >= startAt[a] - 2
                 /\ eventAt[e] <= startAt[a] + 30}
Preferred(e) == LET candidates == Eligible(e)
                   replacements == {a \in candidates : parent[a] # 0}
               IN IF replacements # {} THEN replacements ELSE candidates
Winners(e) == IF e \in history \cup claimed \/ Eligible(e) = {} THEN {}
              ELSE IF MatchAll THEN Eligible(e)
              ELSE {CHOOSE a \in Preferred(e) :
                       \A b \in Preferred(e) : a <= b}

\* receiveHistoryMessage: reconcile BEFORE adding the event to historyItems.
Receive(e) ==
    /\ e \in accepted /\ e \notin history
    /\ LET winners == Winners(e) IN
       /\ echo' = [a \in Locals |-> IF a \in winners THEN e ELSE echo[a]]
       /\ present' = present \ {a \in winners : ui[a] = "unknown"}
       /\ claimed' = IF winners = {} THEN claimed ELSE claimed \cup {e}
       /\ badAssociation' = (badAssociation \/
                              (\E a \in winners : Origin(e) # a))
       /\ consumers' = [consumers EXCEPT ![e] = @ \cup winners]
    /\ history' = history \cup {e}
    /\ UNCHANGED <<now, ui, startAt, calls, pending, accepted, eventAt,
                   parent, rejected, replied, checked, stuckCheck>>

\* Date/older/newer history loading does not call reconcileOutgoingText.
LoadHistoryPage(e) ==
    /\ Scenario \in {"all", "existing"}
    /\ e \in accepted /\ e \notin history
    /\ history' = history \cup {e}
    /\ UNCHANGED <<now, ui, present, startAt, calls, pending, accepted,
                   eventAt, claimed, echo, parent, rejected, replied,
                   badAssociation, consumers, checked, stuckCheck>>

\* Manual checks here return either no record (when none is locally known) or
\* replay already-known records via receiveHistoryMessage. Winners is empty
\* for those records, exactly as in source. Discovering NEW records is outside
\* this action (Receive models their arrival separately). stuckCheck is set
\* only when the original attempt's own event is already in local history.
ManualCheck ==
    /\ \E a \in present : ui[a] = "unknown"
    /\ checked' = ~checked
    /\ stuckCheck' = (stuckCheck \/
          (\E a \in present : ui[a] = "unknown" /\ echo[a] = 0
                             /\ a \in history))
    /\ ui' = [a \in Locals |-> IF EmptyMeansFailed /\ a \in present
                 /\ ui[a] = "unknown" /\ a \notin history
                 THEN "failed" ELSE ui[a]]
    /\ UNCHANGED <<now, present, startAt, calls, pending, accepted, eventAt,
                   history, claimed, echo, parent, rejected, replied,
                   badAssociation, consumers>>

\* 0/1 represent nearby instants; 31 is just outside the UI's +30s bound.
Advance ==
    /\ now < 31
    /\ now' = IF now = 0 THEN 1 ELSE 31
    /\ UNCHANGED <<ui, present, startAt, calls, pending, accepted, eventAt,
                   history, claimed, echo, parent, rejected, replied,
                   badAssociation, consumers, checked, stuckCheck>>

Next == (\E a \in Locals : Begin(a) \/ Submit(a) \/ SteamAccept(a)
                          \/ SteamReject(a) \/ ObserveUnknown(a)
                          \/ ObserveRejection(a) \/ ObserveSuccess(a))
        \/ ExplicitReplacement \/ ExternalAccept
        \/ (\E e \in Events : Receive(e) \/ LoadHistoryPage(e))
        \/ ManualCheck \/ Advance

Spec == Init /\ [][Next]_vars
CheckSpec == Spec /\ WF_vars(ManualCheck)

TypeOK ==
    /\ now \in {0, 1, 31}
    /\ ui \in [Locals -> {"absent", "sending", "unknown", "failed", "sent"}]
    /\ present \subseteq Locals /\ startAt \in [Locals -> {0, 1, 31}]
    /\ calls \in [Locals -> 0..2] /\ pending \subseteq Locals
    /\ accepted \subseteq Events /\ eventAt \in [Events -> {0, 1, 31}]
    /\ history \subseteq accepted /\ claimed \subseteq Events
    /\ echo \in [Locals -> 0..3] /\ parent \in [Locals -> 0..2]
    /\ rejected \subseteq Locals /\ replied \subseteq Locals
    /\ badAssociation \in BOOLEAN /\ consumers \in [Events -> SUBSET Locals]
    /\ checked \in BOOLEAN /\ stuckCheck \in BOOLEAN

NoAutomaticReplay == \A a \in Locals : calls[a] <= 1
FailureSoundness == \A a \in Locals : ui[a] = "failed" => a \notin accepted
\* This counts heuristic matches only, not direct HTTP result handling.
OneEventOneHeuristicClaim == \A e \in Events : Cardinality(consumers[e]) <= 1
NoFalseAttribution == ~badAssociation
NoStuckKnownCheck == ~stuckCheck
KnownOwnEventuallyResolved == \A a \in Locals :
    (a \in present /\ ui[a] = "unknown" /\ a \in history) ~> (a \notin present)

\* Sentinels are intentionally FALSE invariants: TLC must reach each scene.
NotLostAck == ~(1 \in accepted /\ ui[1] = "unknown")
NotLateVisible == ~(1 \in history /\ eventAt[1] > startAt[1] + 30)
NotReplacement == ~(parent[2] = 1 /\ calls[2] > 0)
NotTwoAcceptedCopies == ~(parent[2] = 1 /\ {1, 2} \subseteq accepted)
=============================================================================
