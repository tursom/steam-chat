--------------------------- MODULE TextSendGuard ----------------------------
EXTENDS Naturals
CONSTANTS GuardMismatch, PreserveUncertainty, StatusOnlyFailure

\* Separate subprotocol for a post-submission reconciliation guard failure.
\* The selected/browser account stays fixed. Only the SDK identity transiently
\* disagrees with it; no grant-change notification/reset is assumed.
VARIABLES stage, ui, calls, acceptedCopies, sdkIdentity, manualRetries
vars == <<stage, ui, calls, acceptedCopies, sdkIdentity, manualRetries>>

Init == /\ stage = "ready" /\ ui = "sending" /\ calls = 0
        /\ acceptedCopies = 0 /\ sdkIdentity = "original" /\ manualRetries = 0

Submit == /\ stage = "ready" /\ ui = "sending" /\ calls < 2
          /\ stage' = "awaitingSteam" /\ calls' = calls + 1
          /\ UNCHANGED <<ui, acceptedCopies, sdkIdentity, manualRetries>>

SteamAccept == /\ stage = "awaitingSteam"
               /\ stage' = "awaitingAck" /\ acceptedCopies' = acceptedCopies + 1
               /\ UNCHANGED <<ui, calls, sdkIdentity, manualRetries>>

SdkTimeout == /\ stage = "awaitingAck"
              /\ stage' = "reconciling"
              /\ UNCHANGED <<ui, calls, acceptedCopies, sdkIdentity, manualRetries>>

IdentityMismatch == /\ GuardMismatch /\ stage = "reconciling"
                    /\ sdkIdentity = "original"
                    /\ sdkIdentity' = "different"
                    /\ UNCHANGED <<stage, ui, calls, acceptedCopies, manualRetries>>

\* Legacy: the guard escapes before uncertain:true is constructed. Repaired:
\* preserve that evidence even when reconciliation fails. The client also
\* refuses to treat a bare HTTP status as proof of non-delivery.
Http409 == /\ stage = "reconciling" /\ sdkIdentity = "different"
           /\ stage' = "response409"
           /\ UNCHANGED <<ui, calls, acceptedCopies, sdkIdentity, manualRetries>>

HttpUnknown == /\ stage = "reconciling" /\ sdkIdentity = "original"
               /\ stage' = "responseUnknown"
               /\ UNCHANGED <<ui, calls, acceptedCopies, sdkIdentity, manualRetries>>

ObserveResponse ==
    /\ stage \in {"response409", "responseUnknown"}
    /\ ui' = IF stage = "response409" /\ ~PreserveUncertainty /\ StatusOnlyFailure
             THEN "failed" ELSE "unknown"
    /\ stage' = "finished"
    /\ UNCHANGED <<calls, acceptedCopies, sdkIdentity, manualRetries>>

RestoreIdentity == /\ sdkIdentity = "different"
                   /\ sdkIdentity' = "original"
                   /\ UNCHANGED <<stage, ui, calls, acceptedCopies, manualRetries>>

\* User clicks ordinary retry, not the duplicate-risk explicit replacement.
ManualRetry == /\ stage = "finished" /\ ui = "failed"
               /\ sdkIdentity = "original" /\ calls = 1 /\ manualRetries = 0
               /\ stage' = "ready" /\ ui' = "sending" /\ manualRetries' = 1
               /\ UNCHANGED <<calls, acceptedCopies, sdkIdentity>>

Next == Submit \/ SteamAccept \/ SdkTimeout \/ IdentityMismatch \/ Http409
        \/ HttpUnknown \/ ObserveResponse \/ RestoreIdentity \/ ManualRetry
Spec == Init /\ [][Next]_vars

TypeOK == /\ stage \in {"ready", "awaitingSteam", "awaitingAck", "reconciling",
                       "response409", "responseUnknown", "finished"}
          /\ ui \in {"sending", "unknown", "failed"}
          /\ calls \in 0..2 /\ acceptedCopies \in 0..calls
          /\ sdkIdentity \in {"original", "different"} /\ manualRetries \in 0..1
FailureSoundness == ui = "failed" => acceptedCopies = 0
NoUnintendedDuplicate == acceptedCopies <= 1
NoAutomaticReplay == calls <= 1 + manualRetries
=============================================================================
