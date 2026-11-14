-------------------------- MODULE RestartHistory --------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Mode, ContactCount, MessageCount, PageSize, FaultBudget,
          CrashBudget, SwitchBudget, Inbound
Accounts == {"A", "B"}
Contacts == 1..ContactCount
Sources == {"activeSessions", "localConversations", "friendsList"}
SourceContacts(s) == {c \in Contacts :
    CASE s = "activeSessions" -> c % 3 = 1
      [] s = "localConversations" -> c % 3 = 2
      [] OTHER -> c % 3 = 0}
\* Events 1 and 2 have identical body, direction and second, distinct ordinal.
Event(a, c, n) == [owner |-> a, contact |-> c, number |-> n,
    time |-> IF n <= 2 THEN 2 ELSE 1,
    ordinal |-> IF n <= 2 THEN n ELSE n - 2,
    body |-> "same text", echo |-> FALSE]
History(a, c) == {Event(a, c, n) : n \in 1..MessageCount}
AllEvents == UNION {History(a, c) : a \in Accounts, c \in Contacts}
Top == [time |-> 3, ordinal |-> 0]
Older(e, cursor) == e.time < cursor.time \/
    (Mode # "time_only_cursor" /\ e.time = cursor.time /\ e.ordinal < cursor.ordinal)
Newer(e, f) == e.time > f.time \/ (e.time = f.time /\ e.ordinal > f.ordinal)
Candidates(j) == {e \in History(j.owner, j.contact) : Older(e, j.cursor)}
Page(j) == {e \in Candidates(j) :
    Cardinality({f \in Candidates(j) : Newer(f, e)}) < PageSize}
Oldest(es) == CHOOSE e \in es : \A f \in es : ~Newer(e, f)
Key(e) == IF Mode = "body_dedup"
    THEN <<e.owner, e.contact, e.echo, e.time, e.body>>
    ELSE <<e.owner, e.contact, e.echo, e.time, e.ordinal>>
Idle == [phase |-> "idle", owner |-> "A", round |-> 0, contact |-> 1,
         cursor |-> Top, page |-> {}, todo |-> {}, eof |-> FALSE]

VARIABLES account, round, online, discovered, done, attempted, job,
          archive, receipts, faults, crashes, switches, incoming,
          badCallback, badQuery, retried, partialCrash, replayed
vars == <<account, round, online, discovered, done, attempted, job,
          archive, receipts, faults, crashes, switches, incoming,
          badCallback, badQuery, retried, partialCrash, replayed>>
Current == job.owner = account /\ job.round = round /\ online
CallbackAllowed == CASE Mode = "no_token_guard" -> online
    [] Mode = "no_round_guard" -> job.owner = account /\ online
    [] OTHER -> Current
QueryAllowed == (Mode = "stale_followup" /\ job.cursor # Top) \/ CallbackAllowed
Archived(a, c) == {r.event : r \in {x \in archive : x.bucket = a /\ x.event.contact = c}}
Complete == \A c \in Contacts : History(account, c) \subseteq Archived(account, c)

Init ==
    /\ account = "A" /\ round = 0 /\ online = TRUE
    /\ discovered = {} /\ done = {} /\ attempted = {} /\ job = Idle
    /\ archive = {} /\ receipts = {}
    /\ faults = FaultBudget /\ crashes = CrashBudget /\ switches = SwitchBudget
    /\ incoming = FALSE /\ badCallback = FALSE /\ badQuery = FALSE
    /\ retried = FALSE /\ partialCrash = FALSE /\ replayed = FALSE

\* loggedOn/friendsList initiate/repeat these three independent discoveries.
Discover(s) ==
    /\ online /\ Mode # "legacy"
    /\ discovered' = discovered \cup SourceContacts(s)
    /\ UNCHANGED <<account, round, online, done, attempted, job, archive,
         receipts, faults, crashes, switches, incoming, badCallback, badQuery,
         retried, partialCrash, replayed>>
FriendMessage ==
    /\ online /\ Inbound /\ ~incoming
    /\ incoming' = TRUE /\ discovered' = discovered \cup {1}
    /\ UNCHANGED <<account, round, online, done, attempted, job, archive,
         receipts, faults, crashes, switches, badCallback, badQuery,
         retried, partialCrash, replayed>>
Start(c) ==
    /\ online /\ job.phase = "idle" /\ c \in discovered \ done
    /\ Mode \notin {"legacy", "failure_cache"} \/ c \notin attempted
    /\ job' = [Idle EXCEPT !.phase = "query", !.owner = account,
         !.round = round, !.contact = c]
    /\ attempted' = IF Mode \in {"legacy", "failure_cache"}
                     THEN attempted \cup {c} ELSE attempted
    /\ done' = IF Mode = "early_complete" THEN done \cup {c} ELSE done
    /\ UNCHANGED <<account, round, online, discovered, archive, receipts,
         faults, crashes, switches, incoming, badCallback, badQuery,
         retried, partialCrash, replayed>>
\* A subsequent query must validate the captured token BEFORE calling Steam.
IssueQuery ==
    /\ online /\ job.phase = "query" /\ QueryAllowed
    /\ job' = [job EXCEPT !.phase = "waiting"]
    /\ badQuery' = (badQuery \/ ~Current)
    /\ UNCHANGED <<account, round, online, discovered, done, attempted,
         archive, receipts, faults, crashes, switches, incoming, badCallback,
         retried, partialCrash, replayed>>
\* Response delivery is separate from issuing the request and from persistence.
ReadPage ==
    /\ online /\ job.phase = "waiting" /\ CallbackAllowed
    /\ job' = [job EXCEPT !.phase = "buffered", !.page = Page(job),
         !.todo = Page(job),
         !.eof = Mode \in {"legacy", "single_page"} \/
                  Cardinality(Candidates(job)) <= PageSize]
    /\ badCallback' = (badCallback \/ ~Current)
    /\ UNCHANGED <<account, round, online, discovered, done, attempted,
         archive, receipts, faults, crashes, switches, incoming, badQuery,
         retried, partialCrash, replayed>>
\* One durable append at a time: a crash/fault may interrupt a partially saved page.
Commit(e) ==
    /\ online /\ job.phase = "buffered" /\ e \in job.todo /\ CallbackAllowed
    /\ LET duplicate == \E r \in archive : r.bucket = account /\ Key(r.event) = Key(e)
       IN /\ archive' = IF duplicate THEN archive
                        ELSE archive \cup {[bucket |-> account, event |-> e]}
          /\ replayed' = (replayed \/ duplicate)
    /\ receipts' = receipts \cup {e}
    /\ job' = [job EXCEPT !.todo = @ \ {e}]
    /\ badCallback' = (badCallback \/ ~Current)
    /\ UNCHANGED <<account, round, online, discovered, done, attempted,
         faults, crashes, switches, incoming, badQuery, retried, partialCrash>>
Advance ==
    /\ online /\ job.phase = "buffered" /\ job.todo = {} /\ ~job.eof
    /\ CallbackAllowed /\ job.page # {}
    /\ job' = [job EXCEPT !.phase = "query", !.page = {},
         !.cursor = [time |-> Oldest(job.page).time, ordinal |-> Oldest(job.page).ordinal]]
    /\ badCallback' = (badCallback \/ ~Current)
    /\ UNCHANGED <<account, round, online, discovered, done, attempted,
         archive, receipts, faults, crashes, switches, incoming, badQuery,
         retried, partialCrash, replayed>>
\* No oracle over archive here: completion trusts the executed paging protocol.
Finish ==
    /\ online /\ job.phase = "buffered" /\ job.todo = {} /\ job.eof
    /\ CallbackAllowed
    /\ done' = done \cup {job.contact} /\ job' = Idle
    /\ badCallback' = (badCallback \/ ~Current)
    /\ UNCHANGED <<account, round, online, discovered, attempted,
         archive, receipts, faults, crashes, switches, incoming, badQuery,
         retried, partialCrash, replayed>>
FailureAt(phases) ==
    /\ online /\ faults > 0 /\ job.phase \in phases /\ Current
    /\ faults' = faults - 1 /\ job' = [job EXCEPT !.phase = "failed"]
    /\ UNCHANGED <<account, round, online, discovered, done, attempted,
         archive, receipts, crashes, switches, incoming, badCallback, badQuery,
         retried, partialCrash, replayed>>
Fail == FailureAt({"query", "waiting", "buffered"})
Timeout == FailureAt({"waiting"})
RetryTimer ==
    /\ online /\ job.phase = "failed" /\ Current
    /\ job' = Idle /\ retried' = TRUE
    /\ UNCHANGED <<account, round, online, discovered, done, attempted,
         archive, receipts, faults, crashes, switches, incoming, badCallback,
         badQuery, partialCrash, replayed>>
DropStale ==
    /\ job.phase # "idle" /\ ~Current /\ online
    /\ job' = Idle
    /\ UNCHANGED <<account, round, online, discovered, done, attempted,
         archive, receipts, faults, crashes, switches, incoming, badCallback,
         badQuery, retried, partialCrash, replayed>>
Crash ==
    /\ online /\ crashes > 0
    /\ online' = FALSE /\ round' = round + 1 /\ crashes' = crashes - 1
    /\ job' = Idle /\ discovered' = {} /\ done' = {} /\ attempted' = {}
    /\ partialCrash' = (partialCrash \/ (archive # {} /\ ~Complete))
    /\ replayed' = FALSE /\ incoming' = FALSE
    /\ UNCHANGED <<account, archive, receipts, faults, switches, badCallback,
         badQuery, retried>>
LoggedOn ==
    /\ ~online /\ online' = TRUE
    /\ UNCHANGED <<account, round, discovered, done, attempted, job,
         archive, receipts, faults, crashes, switches, incoming, badCallback,
         badQuery, retried, partialCrash, replayed>>
\* Both same-account reconnect and account change invalidate pending closures.
Switch(a) ==
    /\ online /\ switches > 0 /\ a \in Accounts
    /\ account' = a /\ round' = round + 1 /\ switches' = switches - 1
    /\ discovered' = {} /\ done' = {} /\ attempted' = {} /\ incoming' = FALSE
    /\ UNCHANGED <<online, job, archive, receipts, faults, crashes,
         badCallback, badQuery, retried, partialCrash, replayed>>
Next == (\E s \in Sources : Discover(s)) \/ FriendMessage
    \/ (\E c \in Contacts : Start(c)) \/ IssueQuery \/ ReadPage
    \/ (\E e \in AllEvents : Commit(e)) \/ Advance \/ Finish
    \/ Fail \/ Timeout \/ RetryTimer \/ DropStale \/ Crash \/ LoggedOn
    \/ (\E a \in Accounts : Switch(a))
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(LoggedOn) /\ WF_vars(FriendMessage)
    /\ (\A s \in Sources : WF_vars(Discover(s)))
    /\ (\A c \in Contacts : WF_vars(Start(c)))
    /\ WF_vars(IssueQuery) /\ WF_vars(ReadPage)
    /\ (\A e \in AllEvents : WF_vars(Commit(e)))
    /\ WF_vars(Advance) /\ WF_vars(Finish) /\ WF_vars(RetryTimer) /\ WF_vars(DropStale)

TypeOK ==
    /\ account \in Accounts /\ round \in 0..(CrashBudget + SwitchBudget)
    /\ online \in BOOLEAN /\ discovered \subseteq Contacts /\ done \subseteq Contacts
    /\ attempted \subseteq Contacts /\ receipts \subseteq AllEvents
    /\ archive \subseteq [bucket : Accounts, event : AllEvents]
    /\ faults \in 0..FaultBudget /\ crashes \in 0..CrashBudget /\ switches \in 0..SwitchBudget
    /\ job.phase \in {"idle", "query", "waiting", "buffered", "failed"}
    /\ job.owner \in Accounts /\ job.contact \in Contacts
    /\ job.round \in 0..(CrashBudget + SwitchBudget)
    /\ job.todo \subseteq job.page /\ job.page \subseteq AllEvents
    /\ job.cursor \in [time : 1..3, ordinal : 0..MessageCount]
    /\ job.eof \in BOOLEAN
    /\ <<incoming, badCallback, badQuery, retried, partialCrash, replayed>> \in [1..6 -> BOOLEAN]
CompleteOnlyArchived == \A c \in done : History(account, c) \subseteq Archived(account, c)
AccountIsolation == \A r \in archive : r.bucket = r.event.owner
NoFalseMerge == \A e \in receipts : [bucket |-> e.owner, event |-> e] \in archive
UniqueDurableIdentity == \A r, s \in archive :
    (r.bucket = s.bucket /\ Key(r.event) = Key(s.event)) => r = s
NoStaleCallbacks == ~badCallback
NoStaleQueries == ~badQuery
Recovery == <>[](online /\ Complete /\ done = Contacts)
NeverRecoveredAfterPartialCrash == ~(partialCrash /\ replayed /\ Complete /\ done = Contacts)
NeverRecoveredAfterRetry == ~(retried /\ Complete /\ done = Contacts)
NeverAllSourcesRecovered == ~(ContactCount = 3 /\ done = Contacts /\ Complete)
=============================================================================
