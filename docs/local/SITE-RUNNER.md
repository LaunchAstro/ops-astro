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
(`app.business_id`). The runner learns its actor id from the API session it
signed in with, as the worker does. It passes that id in the `CorrectionRun`
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
  address. A stopped or broken runner goes quiet and the watcher mails.

Starting it on the M5 in production is the owner's daylight go. The plist is
never loaded from a lane.
