# Configure and prove the merge policy

This is the intended hosted configuration. Only the merge queue section and
`.github/required-checks.json` record live settings, as read from the ruleset
on 2 October 2026. Nothing here claims enforcement results. Configure and test
the rest only during an authorised hosted preparation step.

## Configure two rulesets

The primary `main` protection ruleset requires a pull request, passing required
status checks, signed commits, blocked force pushes, and restricted deletions.
It also requires the merge queue and carries CodeQL as a code scanning rule.
Its bypass list is empty, including for the maintainer.

A separate review ruleset requires an approving review. A solo maintainer may
receive an exemption from that review-only ruleset because they cannot approve
their own pull request. That exemption must not cover the primary protections
or remove the independent-model, Copilot, or conformance-proof requirements.

On that review ruleset, enable automatic Copilot code review. Have it review
new pushes. Require every conversation to be resolved. These are three
separate settings and none of them is on by default.

None of these settings guarantees that Copilot reviewed the revision being
merged. Automatic review requests Copilot rather than reporting that a review
finished. Copilot's review does not count towards a required approval.
Conversation resolution governs comments that exist, so it blocks nothing
when no review ran. Establishing that the independent model and Copilot both
reviewed the final head, and that their findings are closed, is the merge
decision's own work. The checklist question about review findings does not
prove it on its own.

Enable merge commits only. Disable squash merging, rebase merging, linear
history, and automatic merging, including dependency updates. These settings
preserve the signed commits and keep the merge an invoked act with a named
actor behind it. That actor is an agent on Nathan's credential once every
required check is green; automatic merging would remove the actor entirely.

## Merge through the queue

Since 2 October 2026 (AEST) every pull request reaches `main` through GitHub's
merge queue. The queue tests each pull request on top of `main` and the entries
ahead of it, merges by merge commit, and drops an entry whose checks fail. Its
settings: build at most 2 pull requests at once, merge 1 to 3 per group, and
fail an entry whose checks have not reported within 90 minutes. A group needs
only one entry, so the 5-minute wait for more never holds a merge. A pull request joins the queue only when an agent
enqueues it, so the merge stays an invoked act.

"Require branches to be up to date" is off
(`strict_required_status_checks_policy: false`). The queue already tests each
entry against the current `main`, so strict mode would only make every open
pull request wait for a re-run after each merge.

CodeQL is a code scanning rule, not a required status check. GitHub posts the
CodeQL results check on pull requests but never on a merge group, so a required
CodeQL check would hold every group until it timed out. The code scanning rule
blocks a merge on CodeQL errors and on security alerts of high severity or
above.

## Bind checks to real hosted results

Read the effective workflow check names and originating apps from a real run.
Require the applicable CI, contamination, secret, licence, provenance,
review-evidence, pull-request-size and DCO results, and, for a change to any
of the eight protected components, each affected component's conformance
proof. Check that each expected result exists for the final revision.
`.github/required-checks.json` records the 13 required checks, the code
scanning rule and the queue settings as the live ruleset holds them; a change
that drops a check from it fails `CQ-13 no check dropped`. `command parity`
and `visual drift` run on every pull request but are not required: they
joined this file's list without ever reaching the live ruleset. Making them
required changes what blocks every open pull request, so it waits until the
batches in flight have landed.

Do not require a Copilot check by name. Copilot's review runs from the
separate review ruleset. The check run it produces does not count towards a
required status check. It belongs to a check suite raised outside the pull
request event, and it is still ignored when the required context is bound to
no app at all. Requiring that name blocks every merge. The review ruleset and
conversation resolution request Copilot's review and block a merge on an
unresolved Copilot comment. Neither reports that a review
finished, so neither is a completion gate.

A missing required check remains pending and blocks merging. A wrong name
usually causes that blocked state; a check omitted from the required list
provides no protection. Verify both configuration and results instead of
assuming either from this page.

The review-evidence validator checks the recorded revision and applicable
security-review attachment. Structured evidence is not proof that a reviewer
actually read the change. Retain the review report and verify the real hosted
path, including Copilot's available completion signal and app identity.

## Prove the actual path

Use the credentials that builders and the maintainer will use. Record each
result against the effective configuration:

1. Direct pushes to `main` fail.
2. An unsigned commit cannot merge.
3. A failing required check prevents merging.
4. A pending or absent required check prevents merging, including for the maintainer.
5. Evidence naming an earlier revision prevents merging until refreshed.
6. A correctly reviewed change with all required checks green merges by merge commit with a verified signature.
7. Squash, rebase merge, and automatic merge are unavailable.

The [seven-question checklist](../../CONTRIBUTING.md) is answered by whoever
invokes the merge, which from the first product pull request is an agent on
Nathan's credential. After it merges, the agent notifies Nathan, naming the
pull request and the merged revision; that notification records what happened
and does not ask permission. An applicable conformance proof remains a
separate required condition, and the decisions listed in
[Contributing](../../CONTRIBUTING.md#who-invokes-the-merge) as Nathan's own
are not reachable by a green check. The merge rule: an agent merges on
Nathan's credential once every required check is green on the head being
merged; a change touching one of the eight protected components merges only on
that component's green conformance proof and Nathan's acceptance; the
production deploy is the one other human gate.
