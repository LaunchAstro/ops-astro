---
name: principle-never-block-on-the-human
description: "Apply when tempted to ask 'should I do X?' on reversible work. Proceed, present the result, let the human course-correct after the fact; reserve confirmation for irreversible actions."
user-invocable: false
---

# Never Block on the Human

The human supervises asynchronously. Agents must stay unblocked: make reasonable decisions, proceed, and let the human course-correct after the fact. Code is cheap. Waiting is expensive.

**Why:** Every permission pause stalls the pipeline and makes the human the bottleneck. Since code changes are reversible and reviewable, a wrong decision usually costs less than blocking.

**Pattern:**
- **Proceed, then present.** Do the work, show the result. Don't ask "should I do X?" Do X, explain why.
- **Reserve questions for genuine ambiguity.** Ask only when you truly cannot infer intent from context.
- **Make the system self-healing.** When you notice a problem, log it and fix it in the next round.
- **Supervision is async.** The human reviews plans, diffs, and changes on their own schedule. Design workflows for review-after-the-fact.
- **Code is cheap, attention is scarce.** A wrong implementation costs minutes to fix. A blocked agent costs the human's attention to unblock.

**Boundaries:**
- **Irreversible actions** (force-push, delete production data, send external messages) still require confirmation.
- **Spend.** Any action that costs money, or that could cost money, requires
  confirmation before it is taken. A paid API key, a purchase, a metered
  service, a model call outside the session's own subscription: all of them
  stop and ask. This boundary is a local addition in this repository and is
  not in the upstream skill. It is listed in the refresh rule in
  `.claude/skills/README.md` so a re-copy from upstream cannot silently drop
  it.
- **Reversible actions** (write code, edit notes, split tasks) should proceed without blocking.
- **Product direction** comes from the human; *execution* should not block.
