# Security review, on any runtime

`AGENTS.md` requires a security review before any pull request touching auth,
tenancy, tool execution, egress, custody or the audit chain.

On Claude Code that is `/security-review`. On Codex, or any runtime without
that command, follow this. A rule only one runtime can obey is not a rule,
which is what the sweep of 6 September found.

## Before you start

Run `node scripts/review-preflight.mjs`. The review is of a **recorded head**,
not of a working tree. Note the base and head; the finding list is worthless
if nobody can say what it was run against.

## What to read

The diff the preflight printed, and, for every file it touches, the file
whole. A diff hides what it does not show: a removed check, a widened scope,
a default that changed three lines above the hunk.

## What to look for, in this order

1. **Tenancy.** Does every query, cache key, queue key, storage path and
   vector key carry the owning business? Is any relationship able to cross
   businesses? Composite keys, not remembered ones.
2. **Authority.** What decides that this caller may do this? Is that decision
   made once, in one place, or re-derived at each call site? Can a caller
   choose its own scope?
3. **Credentials.** Does a token reach a worker, a sandbox or a model
   context? It must not. Is anything logged that should not be?
4. **Egress.** Does the change let a process reach a host it could not
   before? Is a redirect followed? Is a URL taken from a caller?
5. **Execution.** Does anything run code, a package install or a browser? Is
   it in a throwaway sandbox with no network and no socket?
6. **Gates and the audit chain.** Is an approval bound to a hash of the exact
   payload, so it cannot be replayed against a changed one? Is every
   consequential action written to the chain before it is attempted?
7. **Failure.** When the security dependency is down, does the code deny or
   bypass? Absent means safest. A boot in a broken state is a denial.

## What to write

One finding per problem, each with:

- the file and line, from the reviewed head;
- what an attacker gets, concretely, not "could be insecure";
- the smallest change that closes it;
- whether it blocks the merge.

"No findings" is a finding too. Say what you read and what you looked for, so
the next person knows what was already covered.

## What this is not

It is not a penetration test and it is not an assurance. It is one reader
looking hard at one diff. `SECURITY.md` says which controls exist, and today
the honest answer is that none of them are built.
