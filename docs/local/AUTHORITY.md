<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Authority and the domain model, as lane L2 built them

What a caller is, what it may do, and where those two questions are answered.
The data side — migrations, slots, records, tasks — is [DATA.md](DATA.md), which
lane L1 owns this round; this file is the identity, authority and model half and
cross-references it rather than restating it.

Nothing here is a plan. Every mechanism below is in the tree with a test beside
it, and the limits section says what is not.

## The three credentials, which are three things

A person's login, an agent login and a delegation credential are distinct
(transaction contract, delegation). Collapsing any two is the failure the
identity model exists to prevent, and it is the failure that arrives one layer
up from the one migration 0002 guards.

| Credential   | Resolves through               | To                                | Confers                                              |
| ------------ | ------------------------------ | --------------------------------- | ---------------------------------------------------- |
| A person's   | `identity/login-resolution.ts` | `Session` (person, actor, role)   | membership, and nothing else — authority is `grants` |
| An agent's   | `identity/agent-login.ts`      | `AgentSession` (actor, no person) | nothing at all                                       |
| A delegation | `authority/delegations.ts`     | `Delegation`                      | nothing stored; an intersection computed per call    |

A login is in `person_logins` or in `actor_logins`, never both. Two triggers in
0008 hold that from either side, because a login in both would make the order in
which the resolver reads them the thing that decides who the caller is.

`AgentSession` has no `personId` field. Not null — absent. A field that is
sometimes a person is a field some later `??` fills in.

## What the agent may do: the intersection, per call

`checkDelegatedAuthority(tx, delegation, request)` is the whole mechanism, and
what it does not do is the design. It stores no permission, caches nothing, and
copies nothing at mint time. On every call it asks `effectiveGrants` what the
**delegating person** holds right now, and the purpose only ever narrows that.

So the order of its checks is load-bearing:

1. `DELEGATION_EXCLUDES_DECISION` — first, so a decision is never reported as
   something else. **I07.**
2. `DELEGATION_OUT_OF_PURPOSE` — before any grant is read, so an agent probing
   outside its purpose learns nothing about what its person holds. Three ways
   to be outside it: a collection the purpose does not reach, an action it does
   not carry, and a **scope that is not exactly the one task it was minted
   for**. The last is the one-task ceiling: R5 is "R1's delegated agent,
   purpose-scoped to one task", and R1's own grant is business-wide, so without
   the stored scope a call on a sibling task reaches that same grant and passes
   exactly as a call on the picked-up task does. A business- or party-scoped
   request under a delegation is refused here too.
3. `DELEGATION_NARROWED` — the purpose reaches the call and the person's live
   grants no longer cover it. **I08**, and by name: substituting
   `SCOPE_NOT_GRANTED` would say the agent was never authorised, when what
   happened is the authority it drew on was taken away.

Revoking the person's grant therefore collapses the agent on its next call.
There is no path that widens it, because there is no stored permission to widen.

`delegations_never_decide` in 0008 is the same rule as a constraint: a
delegation carrying `decide` cannot be written at all. `authority/index.ts`
exports no decide path either, so I07 is held three times — by the schema, by
the check order, and by what the module does not offer.

## The interfaces L3 consumes

Import from `packages/core-records/src/authority/index.ts`, which is the pinned
surface. A rearrangement behind it is not a change to what L3 imports.

```ts
// authority/delegations.ts
mintDelegation(tx, MintRequest): Promise<DelegationDecision<MintedDelegation>>
resolveDelegation(tx, agentActorId: string, credential: string): Promise<DelegationDecision<Delegation>>
checkDelegatedAuthority(tx, delegation: Delegation, request: ScopeRequest): Promise<DelegationDecision<readonly string[]>>
revokeDelegation(tx, delegationId: string): Promise<void>
settleDelegation(tx, delegationId: string): Promise<void>
digestOf(credential: string): string

type DelegationRefusalCode =
  | 'DELEGATION_EXCLUDES_DECISION' | 'DELEGATION_OUT_OF_PURPOSE'
  | 'DELEGATION_NARROWED' | 'DELEGATION_NOT_LIVE' | 'DELEGATION_WIDENS'
type DelegationDecision<T> = { ok: true; value: T } | { ok: false; refusal: DelegationRefusal }

/** `record` only. Record- and actor-scoped *minting* stays deferred; this is the ceiling. */
interface PurposeScope { readonly kind: 'record'; readonly id: string }

interface MintRequest {
  readonly agentActorId: string
  readonly delegatePersonId: string
  readonly mintedByActorId: string        // the authorising person's acting identity
  readonly purpose: string
  readonly collections: readonly string[]
  readonly actions: readonly Action[]     // never `decide`
  readonly purposeScope: PurposeScope     // the picked-up task's record id, mandatory
  readonly expiresAt: Date                // L4's, from the lease contract
}

// The resolved delegation exposes the same `purposeScope`, read back from
// `delegations.purpose_scope_kind` / `purpose_scope_id` (migration 0016).
interface Delegation { /* ...as before... */ readonly purposeScope: PurposeScope }
```

```ts
// identity/agent-login.ts
resolveAgentLogin(tx, presented: VerifiedSubject): Promise<AgentSession | AgentRefusal>
withAgentSession<T>(database, businessId, presented, run): Promise<T | AgentRefusal>
refuseExpiredSession(): AgentRefusal            // AUTH_SESSION_EXPIRED

// identity/authentication-attempts.ts
recordAuthenticationAttempt(tx, AuthenticationAttempt): Promise<void>
readAuthenticationAttempts(tx, presented: VerifiedSubject): Promise<readonly AttemptRow[]>
```

```ts
// tasks/comments.ts
COMMENT_TYPE_KEY = 'task_comment'; COMMENT_SPINE: readonly SpineField[]
writeComment(tx, commentTypeId: string, comment: NewComment): Promise<string>
readTaskComments(tx, commentTypeId: string, taskId: string): Promise<readonly StoredComment[]>
externalCommentProjection(comments, fields: readonly FieldDefinition[]): readonly Record<string, unknown>[]

// records/preset-plan.ts
planPresetSync(tx, planner: Planner, request: PresetSyncRequest): Promise<PresetPlanDecision<PresetPlan>>
type PresetPlanRefusalCode =
  | 'PRESET_FIELD_UNCLASSIFIED' | 'PRESET_TYPE_UNKNOWN'
  | 'PRESET_FIELD_UNPLACEABLE' | 'PRESET_FIELD_DUPLICATE' | 'SCOPE_NOT_GRANTED'

// `PresetSyncRequest` is unchanged. The authority it asks for is not: `manage`
// on the family named by `recordTypeKey`, not on a blanket `preset` collection.
// L3's `preset.plan` must keep passing the request's own `recordTypeKey`.

// records/business-settings.ts
installBusinessSettings(tx): Promise<void>
readBusinessSettings(tx): Promise<readonly BusinessSetting[]>
readBusinessSetting(tx, key: string): Promise<BusinessSetting | undefined>
```

`installTaskSpine` now also returns `taskCommentTypeId`, which is what
`writeComment` and `readTaskComments` take.

### Refusal codes L3 must register

These are **not** in `IdentityRefusalCode` or `RecordsRefusalCode`, deliberately:
`commands/register.ts` derives its `RefusalCode` from those unions and the
register is L3's file. A model module reaching into the command surface to add a
code is the coupling the register exists to prevent. L3 registers them with the
rest, with HTTP statuses in `apps/api/status.ts`:

| Code                                                                         | Suggested status | Caller-visible                  |
| ---------------------------------------------------------------------------- | ---------------- | ------------------------------- |
| `AUTH_NO_AGENT_IDENTITY`                                                     | 401              | yes                             |
| `AUTH_SESSION_EXPIRED`                                                       | 401              | yes — this is the re-login path |
| `DELEGATION_EXCLUDES_DECISION`                                               | 403              | yes                             |
| `DELEGATION_OUT_OF_PURPOSE`                                                  | 403              | yes                             |
| ↳ _also_ when `request.scope` is not exactly the delegation's `purposeScope` | 403              | yes                             |
| `DELEGATION_NARROWED`                                                        | 403              | yes                             |
| `DELEGATION_NOT_LIVE`                                                        | 401              | yes                             |
| `DELEGATION_WIDENS`                                                          | 403              | yes (mint time only)            |
| `PRESET_FIELD_UNCLASSIFIED`                                                  | 422              | yes, with the field keys        |
| `PRESET_TYPE_UNKNOWN`                                                        | 404              | yes                             |
| `PRESET_FIELD_UNPLACEABLE`                                                   | 409              | yes                             |
| `PRESET_FIELD_DUPLICATE`                                                     | 422              | yes                             |

## The expired session

`refuseExpiredSession()` pins what the server answers when a verified GoTrue
token has expired: a typed `AUTH_SESSION_EXPIRED` refusal a client can turn into
a re-login path. Never an empty result, never a 500, never a silent failure. A
person has to be able to tell "sign in again" from "you may not see this" from
"the server is broken", and only one of those is a door they can open. The
browser half — holding the draft, re-authenticating, resuming — is L5's.

## Every attempt at the door

`authentication_attempts` (0008) is I13's **separate authentication-attempt
owner**. The domain audit records what a command did; this records who got
through and who did not, which is a different question with a different reader,
and on the refusals it is the only record there is — a refused attempt never
becomes an operation, so it has no audit event to hang off.

- Written by both login paths, inside the caller's own transaction, so a
  refusal and its record commit together.
- The presented subject is stored as a **sha256 digest, never whole.** A refused
  attempt carries a subject this business has no relationship with, and storing
  it raw would park an identifier in a tenant that never agreed to hold it.
- On success the verified subject is this business's own `login_id`, `actor_id`
  and `person_id`, which is what "the verified subject" means in product terms.
- The application role has `select, insert` and no `update` or `delete`. A trail
  that can be amended is not a trail.

## The model corrections

**`owning_operation` is `text[]`** (0009). It shipped as one text column holding
space-separated names, which is a list encoded in a string: a reader who forgets
to split sees one operation called `task.complete task.reopen task.start`, and
no such operation exists. The conversion used `string_to_array` on the separator
the old constraint enforced, so no row changed meaning.

`FieldDefinition` carries both: `owningOperations: readonly string[]` is the
model, and `owningOperation: string | null` is the derived joined spelling kept
so the command register and its tests read one source while they move across.
Both come from the same array and cannot disagree. New readers take the array.

**The protected set is still asserted by name** (D02) in
`tests/tasks/task-spine-unit.test.ts`, against `PROTECTED_TASK_FIELDS`, and the
comment type's classifications are asserted in `tests/tasks/comments.test.ts`.

**The free slots are indexed** (0009). `planSlotAssignment` refuses an unindexed
slot — correctly, since the whole point of a slot is a value that can be
filtered — and 0005 indexed only the sixteen the spine reserves. So every one of
the twenty free columns was unusable and `preset.plan`'s only possible answer
was `SLOT_INDEX_ABSENT`. All 38 slots are now indexed; 18 are still reserved,
and the two counts are now separate assertions rather than one.

## Comments

`tasks/comments.ts` installs `task_comment` as a record type beside `task`, so
the classification lives on the field definitions where every surface inherits
it and the conformance set reads it back (D01). Nothing on it is `generic`: a
comment is not a form.

`comment_type` and `audience` are two fields because they answer two questions.
A `system` comment can be addressed to a client, and a `client` comment written
in error can be re-addressed internally without rewriting what it is. Collapsing
them makes "who sees this" a property of "what this is", which is how a leak
arrives with the next kind of comment.

`externalCommentProjection` is an allowlist in both directions (I09). The
comments are the ones addressed to the client — an internal note is **absent**
from the body, not hidden in it. The fields are the ones the catalogue marks
`shared`, read from the definitions passed in rather than a list held in the
module, so classifying a field is the only way to expose it. The test takes
`body`'s classification away and watches the value leave with it.

Comments are **stored and projected through the API**: `task.read` carries them,
in full for an internal reader and through `externalCommentProjection` for every
other role — see the "Reads" heading in `docs/local/API.md`.

## preset.plan

`records/preset-plan.ts` validates the whole preset before emitting a single
action. That is what "before any application" has to mean: a planner that
applied the good half and refused the bad one leaves a business half-synced to a
preset nobody approved, and the next run cannot tell what it decided from what
it inherited. It writes nothing even on success; applying is a separate
authorised operation.

**The authority is the family's, not a blanket preset grant.** The accepted
clause is "existing collection-manager/manage authority bounded to the owned
record family", with "no new role power" beside it. So the planner resolves
`recordTypeKey` to its record type and checks `manage` on _that family_ — the
collection the type's records belong to. There is no collection column on
`record_types` yet, so the record type's key is the family (`task` records are
the `task` collection); `familyOf` is the single place that learns otherwise
when the tree grows a real mapping. Checking a `preset` collection instead
refused the legitimate manager of the task family and admitted a blanket holder
to every installed type, which is the opposite of what the clause bounds. The
type is read before the check but `PRESET_TYPE_UNKNOWN` is returned after it, so
an unauthorised caller still learns nothing about what is installed.

**Duplicate new keys refuse.** `field_defs_key_idx` permits one key per business
and type, so two entries claiming one key cannot both be created. Uniqueness is
checked across the whole request before any action is built, and the refusal
names the keys: `PRESET_FIELD_DUPLICATE`, zero actions, no writes. An installed
field named once is still `no_change`; named twice it is still a duplicate
request. This is ordinary invalid input that a validated dry run rejects rather
than promising an apply that the index will refuse.

"Unclassified" is both halves — absent, and present but not one of the three
modes the model has. A preset shipping `write_mode: 'sometimes'` has not been
decided about either, and defaulting it to `generic` opens a field nobody
opened.

The database's own refusal is **not** the mechanism. `field_defs.write_mode` is
`not null` with no default, so an unclassified field is already impossible to
insert — but that refusal arrives mid-apply and as a constraint violation rather
than as an answer about the preset. D05 says so explicitly, and the test counts
`field_defs` before and after to prove the plan touched nothing.

## Business settings

`business_settings` (0009) is the table the completion item named and four
landed contracts read without having. `records/business-settings.ts` produces
the named rows:

| Key                        | Default             | Write mode  | Why                                          |
| -------------------------- | ------------------- | ----------- | -------------------------------------------- |
| `four_eyes_threshold`      | `500`, `null` = off | `operation` | changes who must agree before money moves    |
| `client_sign_off_required` | `false`             | `operation` | changes who must agree before work completes |
| `retention_window_days`    | `30`                | `generic`   | policy an administrator sets                 |
| `conversation_window_days` | `30`                | `generic`   | policy an administrator sets                 |

The classification is the point, not the values. A setting that decides whether
a second approver is needed is an authority change wearing configuration's
clothes — the same category the task spine protects. Installing is additive: a
second install adds what a later release named and resets nothing, because the
alternative is an upgrade that quietly returns a business's retention window to
the shipped default.

## The restricted worker role

`ops_astro_worker` (0008) exists at the database level with **no privilege
anywhere** — no schema, no table, no function — and the revokes are written out
rather than left implied, because a privilege nobody granted and one somebody
revoked read the same in the catalogue and only one of them was decided (I01
R6). Work reaches the database through an authorised delegation and the
application role, never through a privilege the worker holds itself.

## What is not here

- **No API, CLI or web surface.** Every mechanism above is a model module. L3
  wires `preset.plan`, comments and delegation into the registry and handlers
  from the interfaces pinned above; L5 proves the surfaces.
- **No pickup, handback, lease, gate or decision.** `mintDelegation` is called
  by `task.pickup` when L3/L4 build it; nothing calls it in the tree yet except
  its test.
- **No external comment read.** Comments are stored; the projection function
  exists and no endpoint serves it.
- **No grant-control route.** `issueGrant` and `revokeGrant` are internal
  functions, as they were before this lane.
- **The `settings.*` operations are built.** The two operation-classified
  settings have the commands that own them and a `settings.read` beside them;
  all three are in the table under "The operations L2 made possible" and the
  "Reads" heading in `docs/local/API.md`.
