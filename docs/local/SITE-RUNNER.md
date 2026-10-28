# Site runner design

The site runner is one always-on process on the M5. It takes an approved live
correction from its task, proposes it (`proposeCorrection`), publishes it
(`runLivePublish`) and observes it until the page serves the change. It
composes U92's library and adds no new authority. Ticket #1692, milestone
#1686.

The library already holds every guarantee about sending. The register sends a
publish once, a read under the lease refuses a foreign or expired holder, and
a receipt is written only under a live lease. This process decides what to
run, when, and with which ports.

## Where it runs

A launchd job on the M5 (`deploy/m5/ops-astro-site-runner.plist`, PR2), with
`KeepAlive` set. It runs from a deployed main build, never from a lane
checkout. It is not the hosted API, because a Vercel function can't keep
custody's child process and can be frozen once it has answered
(`apps/api/function.ts:17-25`). It is not the worker, because the worker holds
no database (`.dependency-cruiser.cjs:134-147`). Running it inside the
production worker container is #1697.

## The one configured site

The runner acts for one site, named in its settings (`SITE_RUNNER_SITE`, #1693):
the holder (the business or one of its clients), the repository, the default
branch, the hosting project, and each page with its source file. A token's
scope is never relied on. Every provider call is checked against that site
first, before the host, the credential or the address (`admitting` in
`configured.ts`, the guarded call's `admit`). A call naming another
repository, path, project or page host, a write or head read on any branch but
the default one, or a request opened onto another branch is refused
`SITE_NOT_CONFIGURED`, and nothing is sent. The locate, the proposal and the
publish all go through the same check.

A claim whose correction's site or page is not the configured one runs
nothing. It raises one person task and hands the lease back
`SITE_NOT_CONFIGURED`.

## The locate

Each pass starts with the locate (`locate.ts`), then takes the claims. The two
parts run apart, so a failure in one leaves the other and the heartbeat going.

- It takes up to 20 waiting corrections (`locating` or `requested`) of the
  configured site's holder in turn: those never checked first, then the
  oldest. Another client's corrections are left for that client's own runner.
- Before any provider call, a correction bound to another site is refused. A
  `locating` one settles `unlocated SITE_NOT_CONFIGURED`. A `requested` one is
  put behind the rest, unstamped. A page and file that are not a configured
  pair settle `unlocated NOT_FOUND`.
- It reads the default branch's head once (`site.source.head`), then each due
  path once at that commit (`site.source.read`).
- A `locating` correction is pinned from that file: the word replaced, the
  change inside the envelope, its digests computed once, then `requested`.
  Otherwise it settles `WORD_NOT_FOUND` or `CHANGE_ENVELOPE_EXCEEDED`.
- A `requested` correction is stamped while its file still holds the pinned
  bytes, and superseded once it does not. The pin, the stamp and the supersede
  each write only while the correction's binding is still the configured
  site's, checked in the writing statement.
- A failed or timed-out read backs its corrections off 30 s, 60 s, then 120 s.
  A `locating` correction still unread 120 s after its request settles
  `unlocated SITE_UNREACHABLE`. An answer not in the provider's shape (a field
  missing or of another type, a body that is not JSON, a commit or blob that is
  not a hash, content that is not canonical base64) settles a `locating`
  correction `PROVIDER_RESPONSE_MALFORMED` and counts as a failure for a
  `requested` one.

Before its first write, the proposal reads the head again and the file at it.
If the file no longer holds the pinned pre-image, the proposal refuses
`CONTENT_DRIFTED` with one person task and writes nothing. The publish's blob
precondition stays the final check.

With `SITE_RUNNER_LOCATE_ONLY=1` the runner takes no claim and signs in to no
API, and custody holds the catalogued reads only.

## The lease on the correction's task

The runner takes its lease through the existing queue, under its own agent
delegation, in the same way the worker does (`apps/worker/worker.ts`).

1. A person puts a `site_publish` step on the correction's task and approves
   its gate (`task.propose`, then `task.decide`). The web Launch does this
   (#1695). The approval puts a reservation on the queue. A proposal needs a
   positive ceiling, so Launch names 1 minor unit; the publish spends nothing.
2. The runner reads `task.queue` as its agent actor and takes the
   `site_publish` entries.
3. It picks each one up with `task.pickup`. The answer carries the lease id,
   its fence and its expiry.
4. Under that lease it finds the task's correction in a state it can run
   (`approved`, `accepted` or `unknown`; oldest first, one at a time).
5. It renews the lease with `task.heartbeat` on each pass while it follows
   the correction. It hands the lease back with `task.handback` once the
   correction is settled: `completed` when live, else `failed` with the code.

Finding a correction grants nothing. `readCorrectionForRun` checks under its
locks that the lease is live, is held by this actor at this fence, and covers
the correction's task, and that the delegation still stands. A correction a
person has not approved stops at `APPROVAL_MISSING` before anything is sent.

The claims are a port (`Claims` in `runner.ts`), bound to the API in
`claims.ts`. A person task the runner raises is an internal comment on the
correction's task, written under its lease, and a line in its log.

## Review captures

The runner also takes review captures (#2013, C35), as spare work after the
corrections. It never treats a correction's claim as a capture's.

1. A person puts a `review_capture` step on the review's task and approves
   its gate. The approval puts a reservation on the queue.
2. Each pass, after the corrections, the runner reads `task.queue` again and
   picks up one `review_capture` entry at most, however many wait.
3. Under that lease it finds the task's oldest revision with a width not yet
   landed and claims its captures (`review.capture_claim`). The claim hands
   out only the widths still to land, so a retry never overwrites one.
4. It takes the page observation once (`capturePage`) and a picture at each
   width handed out (`capturePicture`), all through the C18-1 fence. Each
   picture is its own headless Chromium (`picture-browser.ts`): started with
   `PICTURE_BROWSER_ARGS`, a fresh context 1480 by 900 or 390 by 844, no
   script, service workers blocked, every request handed to the fence's
   route. The browser is closed whatever happens.
5. It renews the lease with `task.heartbeat` and lands each width
   (`review.capture_land`).
6. When a land answers `carryDue` (it completed the revision and a pin
   before it is not yet carried there), the runner calls
   `review.carry_pins` for that revision under the same lease, as a call of
   its own (#2166). The land never carries, so the carry's audit is its own
   operation, and the API judges the lease again after the carry's last
   lock wait.
7. It hands the lease back: `completed` once both widths landed and any due
   carry was applied, else `failed` with the code in its report.

The fence's pool for captures holds the configured site's pages only when
that site is the business's own (`reviewPool`, TR-P-1). A runner configured
for a client's site captures nothing, and no other page is reachable until
the pool's reviews are recorded (#2018). A refused page lands nothing and
its lease goes back `failed` with the fence's code. A queue the captures
cannot read fails the pass and pings no heartbeat, as the corrections' does,
and so does a claim refused or never answered: it logs its code, lands
nothing and hands the lease back `failed`. A due carry refused or never
answered fails the pass the same way: it logs its code (`CARRY_FAULT` when
there is none) and hands the lease back `failed`. A refused carry carries
nothing. One never answered may have committed before its answer was lost,
so the runner cannot tell whether the pins moved; a carry is written once
per pin and revision, so a later carry never writes one twice. The captures are spare work, so
they never keep a pass healthy: when the locate and the corrections both
failed, the pass fails however the captures went.
Only codes are printed or reported, never a path or a credential.

Finding the review grants nothing: the API judges the lease, its fence and
the capture rows under lock at the claim and at every land.

## The database login

The runner needs a database handle for the library. It gets its own login and
shares none.

- It is a login role that is a member of `ops_astro_app` only. It owns
  nothing, can't create anything, and is bound by row-level security per
  business, like the API's login.
- It has its own password, held in M5 custody and filed in Bitwarden by name.
  TLS is required. Its connection limit is 2.
- It is revocable on its own: dropping it stops the runner and nothing else.

That login is no narrower than `ops_astro_app` in what it can reach. A role
granted only the tables the runner's records touch needs a migration and its
conformance proof. That is follow-up work, not Tuesday's. Creating the login
on production is an owner step in the runbook (PR2).

## How the actor reaches `db.withBusiness`

The database login carries no actor. `db.withBusiness` sets only the business
(`app.business_id`). The runner learns its actor id from the holder the API
names in its own `task.pickup` answer (`holderActorId`). Before a pickup an
agent may reach only `task.queue`, `task.pickup` and `task.take_launch`
(`BEFORE_PICKUP`, `agent-envelope.ts`), so `session.capabilities` is refused
then. It passes that id in the `CorrectionRun`
with the lease id and fence. Every read and write under the lease compares
`holder_actor_id`, the fence and the task under lock (`holdUnderLease`,
`core-records/src/site/correction-receipts.ts:95`). A wrong or stale actor
gets `LEASE_NOT_OWNED` and writes nothing.

## Credentials and egress

The runner's process never holds a site token. It starts custody
(`startCustody`) with the two site destinations, `source_control` on
`api.github.com` and `hosting` on `api.vercel.com`, built from the catalogue
by `siteDestination`. Each guarded call borrows its credential through
`siteCustody`. The page capture goes through the C18-1 fence: agency pages
only, public addresses only, no redirects. These are the only ways out.

## The re-observe loop

- A publish recorded `accepted` is followed. Each pass, 15 s apart, runs
  `runLivePublish` again on the same lease. The register holds the effect,
  so a pass observes and never sends.
- Following stops at `live` or `unknown`, or at any refusal.
- The cap is 10 minutes from the moment this process first saw the publish
  recorded `accepted`, after that run returned. At the
  cap the runner raises one person task (`LIVE_CHECK_TIMED_OUT`) and hands the
  lease back.
- A lost lease ends the following. The library writes no receipt and raises
  `RECEIPT_NOT_WRITTEN`.

## Restart

Nothing that matters lives in memory. The pickup credential is never written
to disk, so a restarted runner can't renew the lease it held. That lease
lapses at its expiry. The API's sweep fences it, records the drop, tells a
person, and reserves the step again. The runner never marks the task's step
dispatched (the correction's register holds the send), so the step comes back
on the queue (`core-runtime/src/recovery/sweep.ts`). The runner then picks the
task up again under a new lease and a higher fence. A correction the register holds is observed again under that
lease, never sent again (`runLivePublish`, `OBSERVED_AGAIN`). A proposal row
already claimed is followed or reconciled by its seam, never sent twice
(`proposeCorrection`). The 10-minute window starts again from the restart, so
each restart allows another 10 minutes at most, and launchd's throttle bounds
how often that happens.

PR1 proves this with a second runner on a new connection and a second lease
on the task. PR2 proves it with the host in a separate process.

Production has no catalogued read for a branch's head or for an open request
by its branch. So a proposal whose answer was lost reconciles to `unknown` and
raises one person task, rather than being matched by its seam. A catalogued
seam read is follow-up work.

## Park and stop

- **Park.** `launchctl bootout gui/501/ops-astro-site-runner`
  stops the job and keeps the plist. Leases lapse at their expiry, and a
  correction the register holds is observed again on the next start.
- **Stop.** The same command, then remove the plist from `~/Library/LaunchAgents`.
- **The heartbeat.** After each pass the runner pings its own heartbeat
  address, no more often than the settings file's `OPS_HEARTBEAT_EVERY_MS`
  (unset, every pass), so a free watcher's budget holds. A stopped or broken
  runner goes quiet and the watcher mails. A refused `task.queue`, or one with
  no list of work, fails the pass: it pings nothing, never reading as an empty
  queue.

Starting it on the M5 in production is the owner's daylight go. The plist is
never loaded from a lane.
