# Review checkpoints

A review covers an identified set of bytes. Bind the report to the complete
change and invalidate it when those bytes change.

## Normal ticket review

1. Commit the complete ticket on its isolated branch when commits are authorised.
2. Confirm that the worktree is clean and the base is correct.
3. Run `node scripts/review-preflight.mjs [base]` and retain the base and head it prints.
4. Review that revision against the specification and repository standards.
5. After any fix, rerun the affected checks and obtain review of the new revision.

The preflight rejects a dirty tree, the base branch, or an empty committed
diff. It makes a committed review meaningful; it does not prove a review ran.

## Local foundation review while commits are held

The first local foundation review uses the actual proposed files and diff.
It must not invoke a committed-only review on an empty diff or create a
project commit to satisfy the normal preflight.

1. Identify the source baseline and the exact proposed file set, including additions, deletions, and symlinks.
2. Retain a content manifest outside that file set.
3. Give the independent reviewer the actual files, full relevant diff, specification, and check results.
4. Record the manifest identity in the review. After fixes, regenerate the manifest, rerun affected checks, and obtain recheck.

The reviewed snapshot is a local candidate. It carries no new commit,
signature, hosted-check, or publication claim. A later small pull request does
not retroactively certify this initial candidate.

## Hosted evidence

Use the pull request template to record review evidence for the final head.
A later commit makes earlier review evidence stale. Required security
review refers to that same revision. Verify that the ruleset and the check exist
on the hosted repository; a local checkpoint alone cannot enforce merging
behaviour.
