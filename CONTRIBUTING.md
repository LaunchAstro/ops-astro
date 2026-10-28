# Contributing

Issues are open, as information. Anyone may open one and it is read as a
report, not as a request for work. Unsolicited pull requests are closed: the
build loop below routes every change through a ticket, and a change arriving
outside it has no ticket to be reviewed against. The publication checklist
must verify those hosted settings. This document does not claim that hosted
restrictions already exist.

## Follow the build loop

The Matt Pocock workflow in [AGENTS.md](AGENTS.md) is the sole router.

1. Resolve open requirements and record the specification.
2. Confirm the seams and break the specification into reviewable tickets.
3. Implement one ticket in an isolated worktree and ticket branch. Write meaningful tests at the agreed boundaries.
4. Review the actual revision against both the specification and repository standards. A frontier model from a different company than the builder's performs the adversarial review.
5. Obtain Copilot review on the hosted revision and resolve each finding with evidence or a recorded reason.
6. Run the required checks against the final revision. An agent invokes the merge on Nathan's credential once every one of them is green, and notifies him after. The decisions reserved below stay his.
7. Complete the final verify ticket against the integrated feature.

Small work starts at implementation. The first full loop must be rehearsed
on a throwaway feature before product code begins. That rehearsal included
hosted checks, a merge Nathan invoked himself, and a retained CI-checked
verify command. Local foundation checks do not complete that rehearsal.

The [review checkpoint](docs/agents/review-checkpoint.md) binds review to the
complete change. Authorised local foundation work with commits held uses the
actual files, diff, and manifest. It creates no commit or pull request.

## Required reviews and the merge decision

Security review runs before a pull request touching auth, tenancy, tool
execution, egress, custody, or the audit chain. Use `/security-review`, or
[the runtime-neutral procedure](.claude/skills/_shared/security-review.md).

### Who invokes the merge

From the first product pull request after this governance change, an agent
invokes the merge. It runs on Nathan's credential, because his is the only
account with push access. The rule it obeys carries no discretion: every
required check green on the head being merged, or it does not merge. After
merging it notifies Nathan, naming the pull request and the merged revision.
That notification records what happened; it does not ask permission.
Since 28 October 2026, by Nathan's decision, the required checks are the
fast gate and DCO, not full CI, with Sol's approval of the exact head
([current decisions](docs/current-decisions.md#fast-gate-replaces-full-ci-28-october-2026)).

Review is part of that rule because the rulesets hold it, not because the
agent judges it. The review ruleset requests Copilot's review on every push.
The primary ruleset requires every review conversation resolved, Copilot's
included, before the merge button is enabled. Until 28 October 2026,
`review evidence for this revision` was also a required check, so the
code-review and security-review outcomes were stated for the exact head
being merged, and so was the record the cross-company reviewer posted:
`Reviewer:`, `Model:` (not the builder's company), `Head SHA:` and
`Verdict: approve`. Since then that workflow is off and the landing tool
reads the same record for the exact head (or carries it by an identical
range-diff) before it posts `Sol verdict`. The record is copied
text, not proof that the reading happened; [the ruleset procedure](docs/plan/ruleset.md)
says why no required check can. Question four below is answered in the pull
request body and bound to the head by that check, not by a further gate.

These stay Nathan's own decision, and no green check releases any of them:

- the production deploy;
- the five protected parts, T1a, T1d1, T1d2, T1e, and T1i;
- a reduction of any check's tier;
- the sandbox's final contract, approved before implementation.

The merge rule: an agent merges on Nathan's credential once every required
check is green on the head being merged; a change touching one of the eight
protected components merges only on that component's green conformance proof
and Nathan's acceptance; the production deploy is the one other human gate.

### The seven questions

Whoever invokes the merge answers these first:

1. Does the change meet the ticket and acceptance criteria?
2. Are the required checks green for this revision?
3. Is the required evidence present?
4. Did the cross-vendor reviewer and Copilot each review the revision being
   merged, and is every finding from both closed? Answer no if either review
   is missing or bound to an earlier revision. No findings is not the same as
   no review.
5. Did the required security review run?
6. Has the size report been read? About 400 changed lines is a guide for a
   readable chunk, never a gate.
7. Which layer should have caught each finding, and what check now covers it?

The review-evidence check reads question four's answer out of the pull
request body. It proves that the answer is bound to this exact head, and
nothing further: it reads no reviewer identity, so a green `review evidence
for this revision` does not establish that any reviewer read anything.

It does not read the outcome as English. The outcome is the whole text
after `Code review:` or `Security review:` on that line, ignoring case and
one trailing full stop, and it must be exactly one of these forms; anything
else fails, and the failure lists them:

- code review: `no findings`, `the review found nothing`,
  `every finding it raised is closed`, `<N> findings, all closed`,
  `<N> findings, <N> closed` or
  `<N> findings, <M> closed, <K> filed as follow-up #<issue>`;
- security review: `run against <sha>, no findings`,
  `run against <sha>, <N> findings, all closed` or
  `run against <sha>, <N> findings, <N> closed`; on a change that touches
  no sensitive path, the fixed text `not required: no sensitive paths changed`
  as well.

N is the same number on both sides, at least 1, with `finding` for 1. The
follow-up form is for minor findings filed rather than fixed under the owner's
standing permission: M + K = N, K is at least 1, and the check asks GitHub
that `#<issue>` is an open issue here. It cannot see what the issue holds. On a
sensitive change `<sha>` must be the pull request's head. An explanation
goes on the following lines, which the check does not read. So
`approved with 2 findings; 2 resolved` and `no findings after recheck` fail
by design: write `2 findings, 2 closed` or `no findings`, and put the rest on
the next line.

### Pull requests and the merge queue

A pull request's checks are the light set, and they flag issues early. Every
required check still reports on a pull request under its own name, but there
`local checks` runs every step of `pnpm check` across its shards, the build before the tests
because tests read its bundle, with the tests the change reaches in place of
the full test run; the full test run,
`isolation tests` and the database conformance shards run in the merge queue,
and `database conformance` passes on the shards' skip when the contamination
gate passed (a failed gate fails it). Until 28 October 2026 the full set
ran in the merge queue, which tested each pull request on top of `main` and
was the only way into it. Since then `main` has no merge queue and full CI
gates nothing: the fast gate on the exact head does (see above), and this
section describes those workflows for when they run.
A green pull request is therefore not a full run. Before declaring a change
ready, builders run the tests their change reaches, with the commit hook's
lint and typecheck; the landing tool then runs the fast gate's five steps on
the exact head it merges. The full `pnpm check` is not a step before ready.

Those pull request checks run in full only on a pull request next in line
(owner, 12 October 2026). The orchestrator adds the `ci-next` label when a
pull request is next for Sol or the merge queue. Without it, every push still
runs the cheap checks (the contamination gate, gitleaks, licences, commit messages,
size, dependency audit, static analysis and the database conformance gate),
but `full checks` and every job behind it are skipped, and `local checks`,
`isolation tests` and `database conformance` fail with "the full set waits
for the ci-next label". Adding the label starts the run; removing it runs the
light set again. A run reads the labels its event carried, so a push that
started just before the label was added stays light: add the label again. A label change on a closed or merged pull request runs
nothing. `review evidence for this revision` is its own workflow and runs on
every event, label or not (`scripts/full-run.ts`).

A push to `main` runs the full set only when it has to. When nothing tested
the pushed tree, it runs the full set. When a green merge group of `ci.yml`
did, only main's head takes the full set, once, at the end of a batch. A push
main has already moved past runs the light set, and the three aggregates pass,
naming the merge group. Main's head waits until main moves (light) or the
queue empties (full), up to 40 minutes, then runs the full set. Anything it
cannot read means the full set. Pushes to `main` never cancel each other.

GitHub's _update branch_ button writes a merge commit carrying no trailers,
which fails `commit messages and provenance`. A branch need not be up to date
with its base to merge: `strict_required_status_checks_policy` is off, and since 28 October 2026
the landing tool updates each pull request onto `main`, runs the fast gate
there, and merges only while `main` is still the commit it gated (before
then, the merge queue tested each pull request on top of `main`). When a branch does need
its base, for a conflict, merge it locally and push.

A newer push, label change or reopen on a pull request cancels its older
checks still running; a newer run does not cancel a merge group's checks. When
review sends a pull request back for fixes, add the `sent-back` label: it
cancels the ci checks on that head and fails `contamination gate` there, so no
runner is spent on code about to change. The fix push runs every check
again. To run them on the same head instead, remove the label; any other label
change or a reopen runs them too, so the hold lasts until the next such event.
To send back a later head, remove the label and add it again. A held head
cannot enter the merge queue, but one already queued is not stopped: remove it
from the queue as well.

A pull request whose head commit is a merge-queue commit, the tip of a
`gh-readonly-queue/` branch, fails `contamination gate` whatever its branch is
called, so no light pass lands beside the group's own (#724): every ci check
that waits on the gate is skipped, and `database conformance`, which runs
always(), fails. `review evidence for this revision` waits on no gate, so it
runs the same check and fails too. Each lists the queue branches on every
pull request run; when it cannot, or cannot read the head commit, it fails,
and a re-run tries again.

A conformance proof is a separate condition. For changes to the domain
model, tenancy wrapper, queue and delivery contracts, gate engine, credential
broker, egress control, sandbox launcher, or migration system, that
component's conformance test must be green **before merge**, as a required
check. No test, no merge, whatever the review says.

The sandbox also requires Nathan's approval of its **final contract before
implementation**, after adversarial findings are resolved. Model review and
Copilot do not replace either hold.

[The ruleset procedure](docs/plan/ruleset.md) defines the intended hosted
controls. Merge commits only, linear history off, squash off, rebase-merge off,
and no automatic merges. Nobody bypasses required checks or signatures.
Hosted enforcement remains unproven until tested with the actual credentials.

## Attribute and sign work

Every agent-assisted commit carries truthful `Assisted-by: LLM`,
`Agent-model:`, and `Agent-tool:` trailers. The session supplies the actual
model and tool. Every human-only commit carries that human's `Signed-off-by`.
Agents never create a human sign-off. See [AI policy](AI_POLICY.md).

All project commits require cryptographic signatures. The DCO app's intended
organisation-member exemption is separate from provenance requirements.
Outside contributors must personally certify the
[Developer Certificate of Origin](https://developercertificate.org/) and
complete the contributor agreement when contributions open. The CLA is
currently a draft and no signing service is active.

## Keep changes reviewable

The size checker counts product code only, and the size is reported, not
limited (owner, 29 September 2026). About 400 changed lines is a guide for a
readable chunk, a commit or a pull request, never a gate: smaller chunks are
easier to review and to diagnose. Nothing is split into separate sessions,
lanes or review queues to meet a size, and a big change can land as several
such chunks reviewed together. The check prints the changed lines of non-test
code, in total and per file, and passes whatever the size; no waiver label is
needed, and none changes anything. Only a failure to measure fails it. Test
files are listed in the report but never count: a path under `tests/`, or a
file named `*.test.*` or `*.spec.*`. Everything else counts, fixtures and
scripts outside `tests/` included. Lines git marks as moved between non-test
files, indentation changes allowed, are not counted, and the report lists them
per file; a moved line that is then edited counts.

Keep every pull request under 250 commits, the most the DCO check can
evaluate; no ruleset change makes room for more. One ticket per pull request
keeps it there. A pull request that cannot be split waits for Nathan's line
before the DCO check leaves the required checks for its one merge, and the
removal and the restore are recorded on its ticket.

Use synthetic fixtures. Retain third-party licences and attribution. Presets
are data only, as the [preset boundary](docs/licensing/preset-boundary.md)
defines. The [code of conduct](CODE_OF_CONDUCT.md) applies to everyone.
Report vulnerabilities through [Security](SECURITY.md).
