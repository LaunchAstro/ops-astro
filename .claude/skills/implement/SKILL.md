---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

## Checkpoint before review (local rule for this repository)

This section is a local edit. It is not upstream, and it is recorded in
`.claude/skills/README.md` so a refresh cannot silently drop it.

Upstream this skill reviews first and commits afterwards. In this repository
that is the wrong order: `/code-review` inspects `git diff <base>...HEAD`,
which contains committed changes only, so reviewing before committing
reviews a tree that does not contain the work.

So, in this order, and not the other one:

1. Commit the complete ticket to the ticket branch. Everything the ticket
   changes, not the easy part.
2. Run `node scripts/review-preflight.mjs`. It refuses while the worktree is
   dirty or the branch has nothing on it, and prints the base and head when
   the branch is ready.
3. Run `/code-review` against that recorded head, using the exact command the
   preflight printed.
4. If review or the checks produce a fix, commit it. That is a new head, and
   it invalidates the earlier review and the earlier check run. Go back to
   step 2.

Never run `/code-review` on an uncommitted tree. `docs/agents/review-checkpoint.md`
explains why, with the rehearsal that demonstrated it.
