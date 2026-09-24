## What changed

<!-- One paragraph. What this does, and why. Link the issue: Closes #123 -->

## Review checkpoint

<!--
Paste the block from `node scripts/review-preflight.mjs`. It records the base
and the head the review and the checks actually covered. A commit after that
head invalidates both: run them again and paste the new block.
See docs/agents/review-checkpoint.md.
-->

```

```

## Review outcomes

<!--
Replace REPLACE-WITH-OUTCOME on both lines below with one of these forms,
exactly. The review-evidence check reads the whole text after the colon on
that line, ignoring case and one trailing full stop. Anything that is not one
of these forms fails. Put any explanation on the next line; the check does
not read it.

Code review, one of:
  no findings
  the review found nothing
  every finding it raised is closed
  <N> findings, all closed
  <N> findings, <N> closed

Security review, one of:
  run against <sha>, no findings
  run against <sha>, <N> findings, all closed
  run against <sha>, <N> findings, <N> closed
  not required: <reason>

N is the same number on both sides, at least 1, with `finding` for 1.
<sha> is the revision the security review ran against; on a sensitive
change the check requires it to be this pull request's head.
`not required: <reason>` passes only when the change
touches no sensitive path, for example
`Security review: not required: this change touches docs only`. Cite the
procedure file by path on a following line if you want to.

What a green check proves: the evidence is bound to this exact head. It reads
no reviewer identity, so it does not prove that any reviewer read anything.
That is the seven questions' job, in CONTRIBUTING.md.
-->

Code review: REPLACE-WITH-OUTCOME

Security review: REPLACE-WITH-OUTCOME

## How it was tested

<!--
The test that fails before this change and passes after it, by name.
Then anything you ran by hand, with what you saw.
"Tests pass" on its own is not a test plan.
-->

## Agent context

<!--
Fill this in if a model helped write this change. Required for
maintainer-directed agent work; expected as disclosure from anyone else.
See AI_POLICY.md.
-->

- Model and tool:
- What was asked for:
- What was generated:
- What the human checked, line by line or by sampling:

<!-- If no model was involved, write "None" and delete the bullets. -->

## Checklist

- [ ] Under 400 changed lines, or carrying a waiver label with its reason in
      a comment
- [ ] Every commit signed off (`git commit -s`); no sign-off added by a tool
- [ ] Checks green
- [ ] No client data, no real names, no fixture taken from a live system
- [ ] Security review run, if this touches auth, tenancy, tool execution,
      egress, custody or the audit chain
- [ ] Documentation updated, or nothing needed updating
- [ ] The review checkpoint block above matches the current head

## Which layer should have caught this?

<!--
The seventh merge question. For each finding this pull request fixes, and for
each one review or the checks raised in it: which layer should have caught it
first, and did it?

Layers, cheapest first: the type checker, the linter, a test, a check in
continuous integration, a hook, a review, a person reading it later, a
customer.

**The answer becomes a check, not a note.** If the honest answer is "review
caught it and nothing else would have", say what check would have caught it
and either add it here or file it. A trap written down as a paragraph is a
trap that bites again; docs/TRAPS.md says the same thing and deletes its own
entries the day the check lands.

"Nothing could have caught this" is a legitimate answer. It is rare, and it
is worth writing down when it is true.
-->

- Finding →
- The layer that should have caught it →
- The check that now does, or the issue that will add it →

## For the maintainer

- [ ] Ticket and acceptance criterion met
- [ ] Checks green
- [ ] Evidence present
- [ ] The cross-vendor reviewer and Copilot each reviewed this revision, and
      every finding from both is closed
- [ ] Security pass, where the surface calls for one
- [ ] Under the size cap
- [ ] Which layer should have caught this, answered above, and the answer has
      become a check or a filed issue
- [ ] If the diff touches one of the eight components (domain model, tenancy
      wrapper, queue and delivery contracts, gate engine, broker, egress
      control, sandbox launcher, migration system): that component's
      conformance proof is green, or this waits. No test, no merge
