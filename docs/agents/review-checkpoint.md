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

During the internal Stage 1 epoch `DOMAINFIRST20261008`, a lane writes its
ticket line and change and test evidence, then asks the orchestrator to add
`needs-sol`. This label applies to every builder, including Codex. The trusted
repository variable `OPS_INTERNAL_STAGE1_REVIEW_DEFERRAL` must carry that
epoch. The label alone cannot activate the deferral.

The review-evidence check computes the range from the PR's full head SHA and
its merge base with the base being judged. It uses the PR's own head on both
PR and merge-group runs. A move of `main` or a rebase needs no pasted range
or checkpoint update. Review remains owed; this check does not establish
Sol's verdict. The separate reviewer must judge the exact current head.

Lanes already carrying the top-level `Review deferral:` marker and a current
checkpoint may keep that format. Its base must be the judged base or its merge
base with the PR head. The legacy route still requires `unreviewed` and accepts
`needs-sol` or the old `needs-second-model` label. These pasted markers have no
expiry date. Their removal needs a later ticket at a round boundary. Other
checks remain required on both routes.

Outside that trusted deferral, the normal review evidence below still applies.

Use the pull request template to record review evidence for the final head.
A later commit makes earlier review evidence stale. Required security
review refers to that same revision. Verify that the ruleset and the check exist
on the hosted repository; a local checkpoint alone cannot enforce merging
behaviour.

## Before a push that goes to review

Run `node scripts/pre-ready.mjs --pr <number>` (or `--body-file <path>` with
the body you are about to post, and `--labels a,b`) on the committed head. It
runs the review preflight, then in order, stopping at the first red: the whole
`pnpm check`, changed-file lint and the lint ratchet, named-suite registration
of new test files, commit trailers on every commit in the range (merge commits
included), review evidence on the body with the checker taken fresh from
`origin/main`, behaviour test names, and `git merge-tree` against
`origin/main`. `pnpm check` is heavy: run it on the M5 and pass `--skip-check`;
the gate then says it did not run it. The steps after `pnpm check` judge the
committed files of the head, in a throwaway worktree with your installed
tools linked in, and the gate goes red if your tree is left changed when it
ends. The gate calls the existing checkers and changes none of them.
