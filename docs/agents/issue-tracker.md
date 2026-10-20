# Issue tracker

GitHub Issues is the tracker for `LaunchAstro/ops-astro`. Product planning
maps live in `LaunchAstro/ops-astro-roadmap`. Build tickets live in Ops Astro
as native sub-issues of their roadmap map. Cross-repository maps can also
have Ops Astro children when their change lands here.

## Labels and issue types

The tracker uses these issue types.

| Type            | Label                                                                                  | Purpose                                                                   |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Map             | `wayfinder:map`                                                                        | Destination, standing decisions, unresolved questions, and scope.         |
| Decision ticket | `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task` | One question or prerequisite that clears the route through a map.         |
| Spec            | `ready-for-agent` and a `Spec:` title                                                  | Agreed behaviour and acceptance for a set of build tickets.               |
| Build ticket    | `ready-for-agent`                                                                      | One independently verifiable change with its acceptance and dependencies. |

Older decision tickets can carry `wayfinder:ticket`. Read their parent and
resolution before treating them as build work. Source proposals can retain
`enhancement`; a proposal label does not make an issue ready to build.

Specs also carry `ready-for-agent`. A query on that label alone is not a
dispatch queue. Skip `Spec:` issues and check each build ticket's native
blockers and owner before assigning work.

## Wayfinding operations

Each map has Destination, Notes, Decisions so far, Not yet specified, and Out
of scope sections. The map indexes decisions. Their details remain in the
decision tickets and resolution comments. Open work is visible through the
map's native sub-issues rather than a second list in its body.

Use GitHub's native sub-issue relationship for children, including children
in other repositories. A build ticket also links its map and spec under
Parent. Its remaining sections are What to build, Acceptance criteria, and
Blocked by. The body and GitHub's native blocking relationships must agree.
Use native blockers for real prerequisites. A ticket with no blockers says
"None (can start immediately)".

The frontier consists of open, unassigned children whose blockers are all
closed. Check that each closed blocker delivered the needed acceptance.
Assign a ticket to its owner before work starts. Each active build ticket has
one owner and one isolated worktree and branch.

These reads show a map, its children, and a child's native blockers. The
repository is explicit because an issue number alone is local to one repo.

```sh
gh issue view 919 --repo LaunchAstro/ops-astro-roadmap
gh api repos/LaunchAstro/ops-astro-roadmap/issues/919/sub_issues --paginate
gh api repos/LaunchAstro/ops-astro/issues/1627/dependencies/blocked_by --paginate
```

After a decision resolves, record the answer in a resolution comment, close
the decision ticket, and add a named link with a one-line gist to the map.
Leave unspecified work under Not yet specified until its question is clear.
Work outside the destination belongs under Out of scope.

The current product example is [Map: the first agent run](https://github.com/LaunchAstro/ops-astro-roadmap/issues/919).
Its [first agent run spec](https://github.com/LaunchAstro/ops-astro/issues/1612)
and build tickets live in Ops Astro. Watcher-related CI tickets also live
here as children of [Code Factory's watcher map](https://github.com/LaunchAstro/code-factory/issues/121).

## Ticket and section declarations

Every PR body carries a top-level plan declaration and a section declaration.
Use the exact spelling in these examples.

```text
Ticket: C80
Section: checks
```

Use `Ticket: C80, C81` for several plan tickets, or `Unit: U32` for a whole
unit. These IDs come from [docs/build-units.md](https://github.com/LaunchAstro/ops-astro-roadmap/blob/main/docs/build-units.md). A GitHub issue reference
in a title or paragraph does not replace the declaration.

For work outside that plan, including tracker documentation and
watcher-related CI chores, use `Ticket: none`. Link the tracker
issue or map separately in the PR body. Use `Closes #1627` only when the PR
delivers the issue's acceptance. Use a full repository reference for an issue
in another repository.

The round log records the same declarations at boot and when work changes.

```text
2026-10-14T01:00:00Z BUILD-A BOOTED (model, seat example) Ticket: C80 Section: checks machine=m5
2026-10-14T01:01:00Z BUILD-A TICKET Ticket: C81 Section: checks
2026-10-14T01:02:00Z BUILD-A TICKET Ticket: C81 complete Section: checks
```

Use UTC timestamps. Include `machine=m5` when the lane runs on the M5.
Keep Ticket and Section beside each other on BOOTED and TICKET lines.
The `complete` marker records completion of the named plan ticket.

The live roadmap's declared box IDs are `design`, `engine`, `access`,
`checks`, `hosting`, `m5`, `tasks`, `team`, `wayfinder`, `people`, `chat`,
`runs`, `auto`, `sitefix`, `conn`, `docs`, `skills`, `review`, `sitereview`,
`workbench`, `reports`, `crm`, `records`, `portal`, `live`, `money`, `ads`,
and `edit`. Tracker documentation declares `docs`. Watcher-related CI chores declare
`checks`. Each lane declares the box its work belongs to.

The [section map convention ticket](https://github.com/LaunchAstro/code-factory/issues/141)
defines project section maps. The [event grammar](https://github.com/LaunchAstro/code-factory/blob/main/orchestration/events.md)
defines the wire records. The [live roadmap convention](https://github.com/LaunchAstro/ops-astro-roadmap/blob/main/apps/live-roadmap/CONVENTION.md)
defines the plan declarations. Ticket and Section declarations are required
by the round convention even while older readers lack those fields.

## Build evidence and completion

A build ticket names observable acceptance and required evidence. Its PR
links the ticket and reports what was built and how it was verified.
A change to any of the eight protected components requires that component's
green conformance proof before merge. The components are the domain model,
tenancy wrapper, queue and delivery contracts, gate engine, credential
broker, egress control, sandbox launcher, and migration system. The PR names
the affected component and its proof. Model review cannot replace that check.
See [ADR 0049](../adr/0049-senior-engineer-signed-engagement-stop-authority.md)
and [Contributing](../../CONTRIBUTING.md) for the protected-component rules
and Nathan's acceptance. Protected-component work also carries Sol's approval
of the exact head and a clean security review, as the current tickets require.
Review and merge follow Contributing and the lane's current brief. The
orchestrator owns review and landing.

Acceptance added after a merge needs a separate follow-up ticket when it is
unbuilt. Link that ticket to the map and the original issue, and name the
remaining behaviour. A closed issue or merged PR does not prove later
criteria are complete.

Keep built, reviewed, merged, and switched on distinct in the handback.
Name the switch-on step and its owner. Merged work awaiting its switch-on step is still owed.
