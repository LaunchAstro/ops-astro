# Issue tracker: Ops Astro

Issues and specs for this effort live as tasks in Ops Astro. Use the Ops Astro agent CLI (`pnpm cli`, `docs/local/CLI.md`) for all operations: each one below is one CLI call and one request, under the caller's own grants, and every change is recorded and audited by the command that makes it. Ops Astro is the one record: nothing mirrors to GitHub.

Set the connection once, as for any operation (`--business`, `--api`, `--agent` or the environment). A write prints `ok <operation> <id> r<revision>`; pass that revision as `--revision` to the next write on the same record, or read it from `map view`. A refusal prints one line naming the key you lack; a stale revision is refused `VERSION_STALE`, so read again and retry.

## Conventions

- **Create an issue**: `pnpm cli task create --title "..." --description "..."`.
- **Read an issue**: `pnpm cli task get <id> --detail full` (the whole thread and history; `standard` is lighter).
- **List issues**: `pnpm cli task list --detail brief`, then `--page <next>` for the next page.
- **Comment on an issue**: `pnpm cli task comment <id> --revision n --text "..."`.
- **Apply / remove labels**: `pnpm cli task type <id> --revision n --type grilling`. Ops Astro has no free labels: the labels the skills set are `wayfinder:<type>`, and the type is the task's type field (`research`, `prototype`, `grilling`, `task`, and `build` for build tickets). Removing one sets the type back to `task`. Changing to or from `grilling` or `prototype` needs `task:decide` and the map's owner.
- **Close**: `pnpm cli task close <id> --revision n`. A closing note goes on the thread first, with a comment.

## When a skill says "publish to the issue tracker"

Create a task: `pnpm cli task create --title "..." --description "..."`.

## When a skill says "fetch the relevant ticket"

`pnpm cli task context <id>` (work this ticket: the ticket, its map's Destination and Decisions so far, what blocks it and what it blocks, its acceptance checks and the recent thread, in one call).

## Wayfinding operations

Used by `/wayfinder`. The **map** is a task of type `map`; its **child** tasks are the tickets. There is no separate map record.

- **Map**: `pnpm cli map chart --title "..." --destination "..." --notes "..." --fog '["...", "..."]'`. Destination, Notes and Not yet specified (the fog, one patch per line, each with its own id) are the map's components; Decisions so far is rendered from resolved tickets, never written. Read the whole map with `map view`; `map status` gives the frontier, the fog and the counts. The chart may also take `--tickets` (each `{ref, title, type, blockedBy}`, blocking by ref) and prints each ref with the ticket it became.
- **Child ticket**: `pnpm cli task create --parent <map> --type research --title "..." --description "..."`. The type is `research`, `prototype`, `grilling` or `task`; the description holds the question.
- **Blocking**: `pnpm cli task link <ticket> --revision n --blocked-by <blocker>,<blocker>`. It sets the whole list (an empty list clears it); blockers are tickets of the same map, and a cycle is refused. A ticket is unblocked when every blocker is closed.
- **Frontier query**: `pnpm cli map frontier <map>`. The open, unblocked, unclaimed tickets, first in map order wins.
- **Claim**: `pnpm cli task claim <ticket> --revision n`, the session's first write. First come: a second claim on the same revision is refused.
- **Resolve**: `pnpm cli task resolve <ticket> --revision n --answer "..." --gist "..."`. One call posts the answer on the ticket's thread, closes it and puts the one-line gist, linking the ticket, in the map's Decisions so far. Resolving a `grilling` or `prototype` ticket needs `task:decide` and the map's owner.
- **Graduate fog**: `pnpm cli map graduate <map> --revision n --patch <fog id> --tickets '[{"title": "...", "type": "research"}]'`. The patch leaves Not yet specified and becomes the tickets listed, printed in order with their ids; wire their blocking with `task link`.
- **Revise the map**: `pnpm cli map revise <map> --revision n --notes "..."`. Also `--destination`, `--add-fog` and `--add-out-of-scope` (JSON lists) and `--retire <id>,<id>`. Each edit is a new numbered version recording what changed.
- **Rule out of scope**: `pnpm cli task out-of-scope <ticket> --revision n --reason "..."`. Closes the ticket and adds one Out of scope item linking it; it stays out of Decisions so far. Needs `task:decide`.
- **Research artifact**: `pnpm cli task research <ticket>`. A research artefact is a Docs page linked to the ticket, which arrives with Docs (WF-8); until then this answers "not available until Docs", sends nothing and keeps nothing anywhere else.

## The mapping table

The one mapping table, as the spec has it (`CAPABILITY-SLICES.md` section 15a; copy: `tests/cli/api-5-spec-mapping.md`). When the upstream skills change, the spec's table is the one place updated and this file follows; a test fails when the two differ.

| Skill concept (the wayfinder and grilling skills) | GitHub                                                            | Ops Astro                                                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map                                               | an issue labelled `wayfinder:map`                                 | a task of type "map" (CS-15.6)                                                                                                                            |
| Ticket                                            | a sub-issue of the map                                            | a subtask of the map (CS-15.7)                                                                                                                            |
| Ticket type: research, prototype, grilling, task  | label `wayfinder:<type>`                                          | the task's type field; plus "build" for build tickets                                                                                                     |
| Destination, Notes                                | sections of the map issue body                                    | the map's Destination and Notes components                                                                                                                |
| Decisions so far                                  | lines appended to the map body, one per closed ticket, linking it | rendered from resolved subtasks with their gist; `map revised (decision added)`                                                                           |
| Not yet specified (fog)                           | a section of the map body                                         | patch items with ids; `fog graduated (patch, tickets)`                                                                                                    |
| Out of scope                                      | a section of the map body                                         | Out of scope items, linking closed tickets                                                                                                                |
| Blocking                                          | native "blocked by" dependency                                    | the task "blocked by" link                                                                                                                                |
| Frontier                                          | open, unblocked, unassigned children, by query                    | the frontier read model; _map status_ in one call                                                                                                         |
| Claim                                             | assign the issue, first                                           | `ticket claimed` (assignment), first                                                                                                                      |
| Resolution                                        | resolution comment, close, pointer on the map                     | `ticket resolved (answer, gist)` on the thread, close, the rendered line                                                                                  |
| Grilling session                                  | the conversation, the answer posted on the ticket                 | the grilling component: the exchange recorded on the grilling ticket                                                                                      |
| Research artifact                                 | a file on a `research/<name>` branch, linked                      | a Docs page linked to the ticket (CS-15.7); from phase 4 (WF-8), the tracker backend answering "not available until Docs" before then (final plan review) |
| Rule out of scope                                 | close the ticket, one line in Out of scope                        | close as out of scope (`task:decide`), one Out of scope item                                                                                              |
| Tracker operations file                           | `issue-tracker-github.md`                                         | `issue-tracker-ops-astro.md`, over the C69 CLI (CS-15.20)                                                                                                 |

## Pinned upstream files

The upstream skills run unmodified against this file. Their files as vendored (`skills-lock.json`, source `mattpocock/skills`), by SHA-256; a test fails when any of them changes.

| File                                                              | sha256                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.claude/skills/wayfinder/SKILL.md`                               | `fee6e1d0c50f0e736b4ef8a599060c959afae904c9a97d82c97f049fcc3aa0f1` |
| `.claude/skills/grilling/SKILL.md`                                | `10ff989e7498b23b5acb49d5048f11dcd906757d2f79c5cdf8a00001381296f2` |
| `.claude/skills/setup-matt-pocock-skills/issue-tracker-github.md` | `afd6852a80185217bd28aa5cbe456bef1e85be25be7bd1fba382d5b8ee428325` |
| `.claude/skills/setup-matt-pocock-skills/issue-tracker-local.md`  | `7dcda20a2eb4bdc89b95d1143423c0691309921cadae3132e6424f371030506e` |
