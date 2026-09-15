# Configure and prove the merge policy

This is the intended hosted configuration. No effective repository settings
or enforcement results are claimed by this document. Configure and test them
only during an authorised hosted preparation step.

## Configure two rulesets

The primary `main` protection ruleset requires a pull request, passing required
status checks, signed commits, blocked force pushes, and restricted deletions.
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
decision's own work, and the checklist question about review findings does
not by itself prove it.

Enable merge commits only. Disable squash merging, rebase merging, linear
history, and automatic merging, including dependency updates. These settings
preserve the signed commits and require a human merge decision.

## Bind checks to real hosted results

Read the effective workflow check names and originating apps from a real run.
Require the applicable CI, contamination, secret, licence, provenance,
review-evidence, pull-request-size and DCO results, and, for a change to any
of the eight protected components, each affected component's conformance
proof. Check that each expected result exists for the final revision.

Do not require a Copilot check by name. Copilot's review runs from the
separate review ruleset, and the check run it produces is not counted toward
a required status check: it belongs to a check suite raised outside the pull
request event, and it is still ignored when the required context is bound to
no app at all. Requiring that name blocks every merge. What the review
ruleset and conversation resolution do is request Copilot's review and block
a merge on an unresolved Copilot comment. Neither reports that a review
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

The [seven-question checklist](../../CONTRIBUTING.md) remains the human merge
decision. An applicable conformance proof remains a separate required condition.
