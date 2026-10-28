# Current product decisions

Public technical baseline, consolidated 8 September 2026 from Nathan's
confirmed decisions of 6 and 7 September and the 8 September foundation
specification. Later amendments carry their own dates. **Amended 10 September
2026**: engineer approval for the eight protected components was withdrawn
and replaced by a green conformance proof per affected component, per
[ADR 0049](adr/0049-senior-engineer-signed-engagement-stop-authority.md).
This document supersedes earlier public summaries where they differ. It does
not approve implementation, publication, or service activation.

The maintainer's confirmed decisions govern direction. This file carries the
public baseline; ADRs explain its trade-offs and tickets define executable
scope. New decisions must be recorded here before a ticket relies on them.
Private conversation history cannot be an implementation dependency.

## Fast gate replaces full CI, 28 October 2026

Nathan's decision, 28 Oct 2026, a reduction of a check's tier that is his
to make. Full CI no longer gates a merge. Every piece passes the fast gate
on its exact head instead: typecheck, lint, gitleaks with
`.gitleaks.toml`, every migration applied in order on a fresh database
(refusing a duplicate migration, or a new one dated at or below main's
newest), and the unit tests for the files it changes. Its commit status
`fast gate` and `DCO` are main's required checks, and Sol's approval of
that exact head stays the merge condition; an update onto main whose
`git range-diff` against the approved head is identical carries that
approval. The merge rule in the 28 September amendment is unchanged: the
required checks named here are the ones it means.

## Run outcome contract, 18 October 2026

Decision `B2-1623`. Accepted by the owner, 18 Oct 2026, REGISTER 9, with
the director. It records the accepted #1623 design, revision 3 (SHA256
`791901f0`), and its four-piece split plan (`cc9e8a4d`), as cited by the build
plan #1655 revision 2, with the director's rulings of 14 October 2026 on TEST
F5 (`b818274e`) and on the design's third round (`816536dc`). Its other
sources are roadmap#921, the owner's seven-outcome ruling RELAY1623D11222 and
FINDINGS.

**Stack.** The agent loop runs on LangChain `createAgent` over LangGraph at
exact pins: `langchain` 1.5.16, `@langchain/core` 1.2.17,
`@langchain/langgraph` 1.4.21 (held to one copy by an override) and
`langsmith` 0.9.0 as a dependency only. No package is installed before
2026-10-15T13:46Z, and every resolved transitive must be at least seven days
old. No provider package (`openai`, `@anthropic-ai/*`, or any `@langchain/*`
outside core and LangGraph's own) enters the lockfile or the import graph.
Conversation state is `MemorySaver` only, per process. There is no saved
pause, checkpoint store or framework interrupt; approvals, budget, custody and
the run record stay our own.

**Tracing.** No content leaves through framework tracing. The agent refuses
`TRACING_NOT_ALLOWED` when any LangSmith or LangChain tracing or verbose
variable is set, when tracing is enabled or a trace context is inherited, or
when a caller passes callbacks or `verbose` or sets them on the model itself.
It runs each compute step in a
fresh context store, so no inherited configure hook can install a handler.
Diagnostics go to self-hosted Langfuse through the no-content exporter (#1622),
kept apart from framework callbacks.

**Eight outcomes.** Every attempt that stops ends in exactly one outcome,
`success`, `budget_wait`, `call_limit`, `cancelled`, `lease_lost`,
`unknown_provider_outcome`, `waiting_plan_allowance` or `plan_unavailable`,
with one typed end code. There is no free-text code. The eighth,
`plan_unavailable`, is the owner's ruling of 19 October 2026 (register 107):
the ChatGPT plan answering 503 ends the run there, with no retry, and a person
restarts the task.

| Outcome                    | End codes                                                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success`                  | `COMPLETED`                                                                                                                                                                                                                                              |
| `budget_wait`              | `BUDGET_UNAVAILABLE`                                                                                                                                                                                                                                     |
| `call_limit`               | `CALL_LIMIT_REACHED`                                                                                                                                                                                                                                     |
| `cancelled`, person        | `TASK_CANCELLED`, `PLAN_SUPERSEDED`, `DECISION_STALE`, `AUTHORITY_LOST`                                                                                                                                                                                  |
| `cancelled`, broker        | `OPERATION_NOT_CATALOGUED`, `EFFECT_NOT_RECONCILABLE`, `LOCAL_MODEL_REQUIRED`, `CLIENT_MODEL_USE_OFF`, `SOURCE_UNREADABLE`, `RATE_LIMITED`, `COPY_NOT_REGISTERED`, `CARRIAGE_UNAVAILABLE`, `PROMPT_TOO_LARGE`, `CUSTODY_NOT_ADMITTED` and the turn codes |
| `cancelled`, provider      | `PROVIDER_NOTHING_HAPPENED`, `SUBSCRIPTION_SIGN_IN_NEEDED`                                                                                                                                                                                               |
| `cancelled`, door          | `SCOPE_NOT_GRANTED`, `GATE_SHUT`, `DELEGATION_EXCLUDES_OPERATION`, `OPERATION_ID_REUSED`                                                                                                                                                                 |
| `cancelled`, worker        | `TOOL_NOT_CATALOGUED`, `TOOL_REFUSED`, `TURN_MALFORMED`, `TRACING_NOT_ALLOWED`, `DEFINITION_MISMATCH`                                                                                                                                                    |
| `lease_lost`               | `LEASE_EXPIRED`, `LEASE_NOT_OWNED`                                                                                                                                                                                                                       |
| `unknown_provider_outcome` | `LIABILITY_UNKNOWN`, `OPEN_CALL_AT_STOP`, `ANSWER_LOST`, `STILL_ANSWERING`                                                                                                                                                                               |
| `waiting_plan_allowance`   | `LOCAL_PLAN_LIMIT`, `SUBSCRIPTION_PLAN_ALLOWANCE`                                                                                                                                                                                                        |
| `plan_unavailable`         | `SUBSCRIPTION_PLAN_UNAVAILABLE`                                                                                                                                                                                                                          |

The turn codes (`TURN_ORDINAL_STALE`, `TURN_MALFORMED`, `PROVENANCE_UNBOUND`)
arrive with the turn in #1623's third piece. One total function, `outcomeOf`,
turns a stop signal into its outcome and code; a new code fails typecheck until
it has a row.

- **A refusal is `cancelled`** with its own code. A person's cancel and a
  refusal share the outcome, never a code.
- **Unknown stays unknown.** Once a provider call may have been sent, an
  uncertain end is `unknown_provider_outcome`; nothing is charged, retried or
  settled on a guess. A released call counts as nothing happening only for a
  reason the operation declares; any other reason is `LIABILITY_UNKNOWN` with
  the maximum held. Only an explicit `LOCAL_PLAN_LIMIT` or the plan's own
  `SUBSCRIPTION_PLAN_ALLOWANCE` is plan allowance, never a bare rate answer;
  each of the plan's codes counts only where its operation declares it
  (`CHATGPT_PLAN_NOTHING_HAPPENED`). There is no retry and no saved pause; a fresh
  attempt is the existing `task.restart`.
- **The transaction that stops the work writes the outcome**, inside the
  same transaction that retires the work, never later by a worker whose
  authority it retired. The budget stop is #1614's single locked stop
  operation, never a second transition. When that operation ends a run past
  its consolidated third ask, the attempt it stopped still records `budget_wait`
  / `BUDGET_UNAVAILABLE`; the run's `cancelled` state and the alert to a
  person say that it ended. A worker reports what only it can see
  through `run.end`, which keeps live-lease authority and never releases or
  settles a hold on the worker's word.
- **Every reserve stop, not only `run.end`,** re-checks the worker's session
  after its last lock wait, before it writes. A session ended during the wait
  gets the session refusal, and nothing is committed.
- **An open call wins.** If any of the attempt's calls is dispatched or of
  unknown liability when a stop commits, the outcome is
  `unknown_provider_outcome` and the intended code is kept as the stop cause.
  Unsent holds are released; a dispatched call keeps its liability and its
  late answer still settles.
- **Only success hands work back** for review. Success is refused with an
  outcome already recorded, a call still open, or a step-level unknown.
- **The record.** `run_outcomes` holds one row per attempt: business,
  attempt, planned run, outcome, end code, stop cause, agent version, when and
  by whom. The first writer wins by its key; the row is never updated or
  deleted by any role; its facts come from the attempt and lease, never from a
  caller's operands; row security scopes it by business. It sits beside the
  existing attempt and audit rows, which keep their meaning: an attempt's
  `outcome` (`completed`, `failed`, `abandoned`, `unknown`) and state still
  record its accounting, and the outcome records why the work stopped. A later
  settlement changes the ledger, never the outcome.
- **The read.** The stored outcome and end code are returned on the existing
  task execution read, so the task needs no new read to show them.
- **TEST F5** for #1623 is stop, restart, then claim and apply once: with the
  API stopped nothing is claimed or applied, and the receipt after the restart
  cites the Launch decision. Work continuing while the whole API is down is a
  later item, outside #1623.

## Projects and Tasks visual reference, 12 October 2026

Decision `R20261012`. Nathan makes the running Hub mockup the canonical
layout and typography reference for Projects, Tasks, their Team and Agent
views, and the Notifications, Agent, Clients and Projects dock panels. Data
and licensed icon shapes may differ. Match the reference's intentional font
sizes, weights, line heights and spacing using the existing measured-type
exception mechanism; the older snapped scale does not override this ruling.
Use shared styles and controls, custom dropdowns, inline `@` suggestions and
hover or focus callouts. Remove Settings from the shipped dock registration;
its full page and frozen stored identifier remain. Retain real operation,
ownership and authority behaviour. The director owns integration and merging.
Implementation and verification details are in [visual parity](../VISUAL-PARITY.md).

## A dormant launcher identity grants a Launch nothing, 12 October 2026

Owner decision on #804 (its F4, comment 6125140111). A Launch draws on its
delegating person's grants and on those of the acting identity it was minted
on. A grant on that identity counts only while the identity is active:
dormant means inactive. A Launch backed only by a dormant launcher identity
is refused `DELEGATION_NARROWED`, the Access preview shows it with nothing,
and a write that asks again after its last lock wait is refused by a
deactivation that committed during that wait. The person's own grants are
unaffected. Built in #1499 (`delegatingSubjects`, `effectiveGrants`).

## Single-operator Launch, 18 October 2026

Decision `R5-S1-20261018`, R5 in
[Spec: Agents work a task (runs)](https://github.com/LaunchAstro/ops-astro/issues/1655),
recording seam S1 as the director settled it on 14 October 2026. Nathan
accepted it on 18 October 2026, including his own hand-typed request, Astra's
review before the first self-approval and the revert ask (owner questions a, c
and d; the round register, items 10, 11 and 13).

- An operator is an active member of the business in a staff role (owner,
  administrator or member): the people who may be the configured approver.
- Single-operator mode is a business setting, `single_operator_mode`, off by
  default, set by `settings.set_single_operator` under `settings:manage`.
  Turning it on is refused unless the business has exactly one operator.
  A membership change that leaves the business without exactly one operator
  (a second added, or the last ended) turns it off in the same transaction,
  whatever wrote the membership.
- While it is on, the configured approver may approve a live correction they
  requested themselves, or one their own agent requested. This covers the
  owner's own hand-typed request too, not only the agent's. The decision
  re-reads the mode and the operator count under its lock, so a second
  operator added while it waits is seen and the approval refused with nothing
  written. Like any approval, it lands only while the site runner checked the
  page within the last 60 seconds (#1693).
- The business's first such approval also needs Astra's review recorded on
  the correction, bound to its exact version digest and approving it; the
  latest review of that version is the one that counts. The
  owner records it with `live_correction.record_review`, carrying Astra's
  saved review and the digest, which the server checks against the stored
  version (owner question c, the recommended answer). The review is recorded
  only on a version the site runner checked within the last 60 seconds, so a
  refused review never admits the approval (#2063). The server refuses
  without it; hiding the button is not the control.
- Every such approval is marked as a single-operator self-approval on the
  correction's decision, which is never rewritten. The decision is the
  correction's durable record, and its receipts are read with it. An agent
  run's own event record is not written here.
- The storage admits a decision by the requester only on a row carrying that
  mark, and the command writes the mark only after its checks pass. With the
  mode off, self-approval is refused as before, and another configured
  approver decides as today.
- The owner may also ask to revert a correction they requested, under the
  same mark (owner question a, the recommended answer). A forward revert by
  hand stays the fallback.

## Own-business site, 18 October 2026

Decision `R6-S2-20261018`, the first part of R6 in
[Spec: Agents work a task (runs)](https://github.com/LaunchAstro/ops-astro/issues/1655),
recording seam S2 as the director settled it on 14 October 2026. Nathan
accepted it on 18 October 2026 (owner question d; the round register, items
10, 11 and 13).

- A business's own site is bound to the business itself, not to a party. It
  is the business's one site row with no party. A client's site stays bound
  to that client.
- No party record is the business. A client can never take the business's
  own identity, and no label on a client admits anything; the storage
  refuses a client whose identity is the business's.
- A task with no client may request a live correction only on a page of its
  own business's site. A task with a client may request one only on a page of
  that client's site. Any other pairing stores nothing. The task's client is
  read in the request's own statement, after its lock wait, so a client set
  on the task while the request waits is seen and refused.
- A correction on the business's own site carries no party. Only a
  business-wide grant reaches it; a grant scoped to a client never does.
- The proposal reads the correction's site through the same binding.
- Admitting own-business work on a subscription route, judged by the task's
  source, is the second part of R6 (#1699). Client-party work never gains
  plan eligibility. The broker reads the run's task's client and source after
  its last lock wait at admission, and again at custody's handoff. An agent
  asks on the business's own site only while its task is still the owner's
  own work, read after the request's lock wait by the broker's own reader
  (`CORRECTION_NOT_OWN_WORK`). A replay of that request holds the task from
  before its audit-chain wait, its last, reads it again after that wait, and
  a refusal takes the replay's audit event back (#1877).

## Selected foundation

| Area                   | Decision                                                      | Proof still required                                             |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Application            | TypeScript, React, Vite, and Hono                             | First real product slice                                         |
| Operational store      | Organisation-owned Supabase/Postgres                          | Schema, migrations, access and recovery tests                    |
| Login                  | Supabase Auth behind the product's own permissions contract   | Adapter and exit test to a named alternative                     |
| Records                | Fixed typed slots; tasks are a built-in record type           | Field inventory, slot sizing, backfill and query tests           |
| Knowledge              | Postgres is canonical; exports are projections                | Rich-document body format and safe edit contract                 |
| Diagnostics            | Langfuse selected, optional per installation                  | Pinned profile, licence, access, lifecycle, and trace delivery   |
| Data design            | Separate ClickHouse roles for Langfuse and business analytics | Ownership, mapping, isolation, lifecycle, and deployment profile |
| Development            | Matt Pocock build loop; Pstack standards within it            | Complete hosted rehearsal before product code                    |
| Shared UI and registry | One design system and typed capability contract               | Transfer and independent discovery checks from the first slice   |

The detailed decisions are indexed in [ADRs](adr/README.md). As of 8 September
2026, all product components remained unbuilt in this foundation; the dated
paragraph below records the integrated head. LangChain and LangGraph are
selected for the agent loop at the pins in the run outcome contract above (decision
`B2-1623`); Deep Agents and Langflow remain unselected. No new framework is
required to publish the foundation or prove a deterministic local task flow.

### State at the integrated head, 23 September 2026

The paragraph above describes the foundation as it stood on 8 September. Since
then a local task slice has been built against these decisions: records, the
authority model, a bounded runtime, an HTTP API, a command line and a web
application are in the tree with tests, and a person can sign in, create a
task, assign it, change its state and reload it against a real local Postgres.
[The local slice](local/README.md) describes what exists, what proves it
and what it does not do. Read it before any statement here about what is
built. This paragraph records state, not a new decision. Every decision above
stands unchanged and the proof column is still owed. No review of the
integrated head has been recorded, so nothing in the slice is accepted.

## Current domain and behaviour decisions

| ID  | Confirmed requirement                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | Mobile remains on the roadmap. A smaller companion and its implementation are deferred.                                                                                                                   |
| C02 | One enduring person identity within each business links changing roles and histories. Removing a login preserves the person's records. Names or email alone must not silently merge confidential records. |
| C03 | Groups and individuals receive explicit resource and action permissions. Clearance and team membership alone are insufficient.                                                                            |
| C04 | Organisation administrators may appoint collection managers with bounded authority over assigned collections.                                                                                             |
| C05 | Break-glass means heightened review for high-consequence actions. It grants no emergency account or permission bypass.                                                                                    |
| C06 | The graph explains tasks, runs, dependencies, proposals, reviews, revisions, and outcomes. It is not an executable canvas or graph database decision.                                                     |
| C07 | Mentions and assigned work route review requests. Routing, assignment, and task completion do not grant authority or constitute a decision.                                                               |
| C08 | Request Changes allows bounded revision within the approved scope and budget. Extra cost, access, or scope waits for new approval. Reject stops work pending an authorised restart or redirection.        |
| C09 | Amendments retain plans, attempts, decisions, costs, and valid completed work. Changed dependencies and effects receive renewed review.                                                                   |
| C10 | Operators have explicit recorded operating and recovery powers. Account ownership remains with the organisation.                                                                                          |
| C11 | Attachment preview, download, and API retrieval check current permission. Copies in prompts, outputs, logs, checkpoints, and traces require their own controls.                                           |
| C12 | Include both ClickHouse roles in the initial data design. Keep business analytics separate from Langfuse's internal schema and credentials.                                                               |
| C13 | Characterise existing behaviour and selectively keep, adapt, redesign, or drop each module. File copying and language conversion do not prove acceptance.                                                 |
| C14 | Transferred capabilities require behavioural tests, debugging, independent model review, Copilot review, and retesting at the actual revision. Protected-component conformance proofs remain.             |
| C15 | Group implementation, necessary corrections, and evidence into useful deliverables. Routine status bookkeeping does not need separate pull requests.                                                      |
| C16 | Target a verified public foundation followed by a coherent local task demo. The exact publication/history procedure remains separate and cannot bypass signing, review, merge strategy, or size rules.    |
| C17 | Consolidate this baseline and supporting evidence before new implementation planning. Reopen decisions for named gaps, changed requirements, or contrary proof.                                           |

## Sequence and holds

The proposed roadmap is foundation, tasks and basic approval, agent work,
Docs, richer review, and CRM. No dates or fixed slice totals are established.
The [first task specification](plan/first-task.md) is the 8 September
product proposal. The slice that was built differs from it, and the
specification does not release its draft tickets.

The full build-loop rehearsal precedes product code. A green conformance
proof is required before merging changes to the eight protected components.
The sandbox's final contract must be approved after adversarial findings are
resolved and before implementation. [Contributing](../CONTRIBUTING.md) is the
canonical review and merge procedure.

**Amended 23 September 2026**: from the first product pull request after the
governance change that carries this amendment, an agent invokes each merge on
Nathan's credential. Its rule has no discretion: every required check green on
the head being merged. It notifies him after the merge, naming the pull
request and the merged revision. The production deploy, the five protected
parts (T1a, T1d1, T1d2, T1e and T1i), a reduction of any check's tier and the
sandbox's final contract stay his decision; the coherence waiver left this
list on 29 September 2026 (FU-400), when the size became reported, not
limited. Automatic merging stays disabled. Per
[ADR 0046](adr/0046-merge-mode-machine-proven-merges.md).

**Amended 28 September 2026** (CQ-13, on Nathan's line of that day). The merge
rule: an agent merges on Nathan's credential once every required check is
green on the head being merged; a change touching one of the eight protected
components merges only on that component's green conformance proof and
Nathan's acceptance; the production deploy is the one other human gate.
Pull requests stay under 250 commits, with no ruleset change. Identifier
resolution stays, tested, for its named callers MP-8-6 and C48; API-1's
command catalogue replaces capability-map discovery, which was not ported.

**Amended 29 September 2026** (API-1). `packages/core-wire/src/catalogue.ts`
answers what the first slice's capability-map discovery answered: which
commands a principal may call, and through which surface. That discovery is
replaced by the catalogue, not ported. The check `command parity` runs
`node scripts/command-parity.mjs --check` on every pull request; it is not in
the live ruleset's required checks (see `docs/plan/ruleset.md`).

**Amended 30 September 2026** (S0-5, its first part). Each catalogue row
carries the command's data effects (`packages/core-wire/src/data-effects.ts`):
the tables it writes with their scope, its intake, outside effects and
whether it admits an outside person. Its class (`invitation`, `client-data`
or `made-up-safe`) is derived from them, never set by hand. A command with
no entry does not compile, and each entry is proved against the rows its
fixture changes. The readiness check reads the class (S0-5, its second
part): a real-data installation refuses every `client-data` and `invitation`
command `GATE_SHUT` 409 while any of the eight gate items or three closing
lines (migration 0060) is open, on the person and agent routes, after
authority and before the handler. The mode
and the items live in `ops` (migration 0058); the mode moves one way, from
made-up to real, only while every item is done. Recording an item and changing
the mode are commands under `operations:manage` in the business that operates
the installation (migration 0059); accepting a finding is not built yet.
`task.set_party` refuses `CLIENT_LOCKED` 409 once the task has content (its
history or a row naming it), under the task's row lock. A subtask, live or in
the trash, is content of its parent (ruled 1 October 2026, S0-5 over MP-4-4): a
parent with subtasks keeps its client and nothing moves down its subtree, and a
parent whose only subtask is in the trash keeps its client too, so the subtask
comes back from the trash on its parent's client. A task with no subtasks can
still be moved in one step, and 'duplicate without contents' is the path for
one that has them. A reparent reads the new parent's client under the parent's
row lock, so it cannot pass on a client the parent is losing. `task-subtasks`
names the rule.

No external engineer review, legal opinion, security assessment, hosted enforcement,
mailbox delivery, or service deployment is certified here. A public technical
evidence digest with adjudicated verdicts remains outstanding. The
[plan index](plan/README.md) distinguishes that work from the private archive.

## Historical synthetic literal decision, 10 October 2026

Decision `NATHAN-HISTORICAL-SYNTHETIC-20261010`. Nathan confirmed that the two
historical versions of `tests/web/mp-4-13-prefill-from-the-page.test.ts`
listed below contain synthetic, non-client fixtures and approved the scoped
exception. The affected blobs are `db23f253db62a8e7c457a17ef759ba7d2ae62387`
and `94a6774cc918c1020d92c2b4476dc0715b897d04`, bounded by historical main
`6b415ddb6f30e04e37d0b26436f0ddf72abea6e7`. PR #1095 already corrected the
current file. This decision permits only the exact path, blob and normalised
term tuples committed through the salted external receipt in
`scripts/gate/literal-history-approvals.sha256`.

Every inspected occurrence must be an ancestor of the fixed anchor. Every
selected outgoing tip must exclude both historical blobs. Reintroduction, a
different path, changed bytes or another term remains refused. The private
receipt and term digest stay outside Git. The full first-push range, normal
hooks, hashed and shape scans, public-content checks and merge requirements
remain in force. This decision neither permits client material nor treats
the earlier retained matches as clean history.

On 11 October 2026 Nathan corrected the description: the approved term in
those two blobs is a team member's first name, not a client and not a made-up
word. He ruled it harmless and asked for no history rewrite. The existing
receipt already covers it: the same path, the same two blobs and the same
term digest, so the registry is unchanged. A first push clears the literal
sweep only when the hook environment supplies the receipt through
`HUB_GATE_LITERAL_HISTORY_RECEIPT`, beside `HUB_GATE_TERMS`.
