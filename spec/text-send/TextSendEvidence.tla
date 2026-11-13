-------------------------- MODULE TextSendEvidence --------------------------
EXTENDS TextSend

\* Repaired UI: historical matches are evidence, never request confirmations.
\* Reuse the legacy model's independent transport/Steam/UI actions. No action
\* here invokes the legacy heuristic Receive or ManualCheck.
CONSTANTS SkipExistingEvidence, KeepThirtySecondWindow
VARIABLE evidence
evidenceVars == <<vars, evidence>>

EvidenceInit == Init /\ evidence = {}

EvidenceEligible(e) == {a \in present : ui[a] \in {"sending", "unknown"}
    /\ eventAt[e] >= startAt[a] - 2
    /\ (~KeepThirtySecondWindow \/ eventAt[e] <= startAt[a] + 30)}
EvidenceFor(e) == IF SkipExistingEvidence /\ e \in history THEN {}
                 ELSE EvidenceEligible(e)
KnownEvidence == {a \in present : \E e \in history : a \in EvidenceFor(e)}

ObserveEvidence(e) ==
    /\ e \in accepted
    /\ e \notin history \/ EvidenceFor(e) \ evidence # {}
    /\ evidence' = evidence \cup EvidenceFor(e)
    /\ history' = history \cup {e}
    /\ UNCHANGED <<now, ui, present, startAt, calls, pending, accepted,
                   eventAt, claimed, echo, parent, rejected, replied,
                   badAssociation, consumers, checked, stuckCheck>>

CheckEvidence ==
    /\ \E a \in present : ui[a] = "unknown"
    /\ LET nextEvidence == evidence \cup KnownEvidence IN
       /\ evidence' = nextEvidence
       /\ stuckCheck' = (stuckCheck \/
           (\E a \in present : ui[a] = "unknown" /\ a \in history
                              /\ a \notin nextEvidence))
    /\ checked' = ~checked
    /\ UNCHANGED <<now, ui, present, startAt, calls, pending, accepted,
                   eventAt, history, claimed, echo, parent, rejected,
                   replied, badAssociation, consumers>>

EvidenceNext ==
    \/ (( (\E a \in Locals : Begin(a) \/ Submit(a) \/ SteamAccept(a)
                          \/ SteamReject(a) \/ ObserveUnknown(a)
                          \/ ObserveSuccess(a))
       \/ ExplicitReplacement \/ ExternalAccept \/ Advance
       \/ (\E e \in Events : LoadHistoryPage(e)) ) /\ UNCHANGED evidence)
    \/ (\E a \in Locals : ObserveRejection(a) /\ evidence' = evidence \ {a})
    \/ (\E e \in Events : ObserveEvidence(e))
    \/ CheckEvidence

EvidenceSpec == EvidenceInit /\ [][EvidenceNext]_evidenceVars
FairEvidenceSpec == EvidenceSpec /\ WF_evidenceVars(CheckEvidence)

EvidenceTypeOK == TypeOK /\ evidence \subseteq Locals
\* No historical evidence silently removes an unknown attempt. User dismissal
\* is intentionally outside the model and is not claimed as delivery proof.
UnknownRemainsUnconfirmed == \A a \in Locals : ui[a] = "unknown" => a \in present
EvidenceIsReal == \A a \in evidence : \E e \in accepted :
    eventAt[e] >= startAt[a] - 2
KnownOwnEventuallyExplained == \A a \in Locals :
    (a \in present /\ ui[a] = "unknown" /\ a \in history)
        ~> (a \in evidence \/ a \notin present)
NotKnownEvidence == ~(1 \in evidence /\ 1 \in history /\ ui[1] = "unknown")
=============================================================================
