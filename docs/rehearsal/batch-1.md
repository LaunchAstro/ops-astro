# Batch 1 route rehearsal

A disposable branch that proves the batch route: a draft pull request from
the batch branch to `main` runs every required check on each push, a failing
test turns it red, a corrected candidate turns it green, and the review
evidence check accepts only evidence bound to the exact head.

This file never merges. The pull request that carries it is closed when the
rehearsal ends.

## Slice A

A docs-only candidate on its own slice branch, merged into the batch by the
integrator.
