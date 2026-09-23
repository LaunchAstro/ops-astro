// SPDX-License-Identifier: AGPL-3.0-only
//
// What every command needs before it can do anything: the installed task
// type, the caller's authority, the record the request named, and the
// revision that record is actually at.
//
// All four are here rather than in the commands for the same reason the
// envelope owns the audit event. A command that read its own target could
// read it with a different filter; a command that checked its own authority
// could check a different action; and the one that forgot would look exactly
// like the others until someone tried it.
//
// The order is deliberate. Authority comes before the read, so a caller with
// no grant learns nothing about whether the record exists. The read comes
// before the revision comparison, so a stale revision against a record that
// is not there is `NOT_FOUND` and not `VERSION_STALE` — the first answer tells
// the caller nothing they did not already present.
//
// The read of the target also *locks* it. A review found the revision check
// reading a row another transaction was already rewriting: two `task.update`
// calls presenting the same `expectedRevision` both passed the comparison —
// each against the committed row, neither seeing the other's uncommitted write
// — and both applied, so the second silently restored the first's old title
// and the caller who lost was told `applied`. Optimistic concurrency is only
// as good as the row the comparison reads, so the row is taken `for update`
// before it is compared: the second transaction waits, re-reads the revision
// the first committed, and is refused `VERSION_STALE` as the contract says.
// The lock is here, in the one read every targeted command shares, for the
// same reason the authority check is — a lock taken by each handler is a lock
// the next handler forgets.
//
// The authority *target* likewise comes from the declaration and not from the
// body. It was derived from `request.recordId` whenever the field was present,
// which meant an untargeted command inherited whatever record the caller named:
// a record-scoped write grant that is refused a plain `task.create` was allowed
// one by sending the `recordId` of the record it did hold. A command that
// targets no record is checked against the business, and a target field that
// its declaration has no use for is refused rather than ignored.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Session } from '../identity/login-resolution.ts';
import { checkAuthority, subjectsOf, type Scope } from '../authority/grants.ts';
import type { EntryPoint } from '../tasks/placement.ts';
import { fromAuthority, refuseCommand } from './refusal.ts';
import { refused, type Refused } from './outcome.ts';
import { readTaskSpine, type CommandContext, type TaskRow } from './context.ts';
import type { CommandDeclaration } from './surface.ts';
import type { CommandRequest } from './requests.ts';

export const REVISION_FIXES: readonly string[] = [
  'Read the record and send the revision you are writing against as expected_revision.',
  'A write against a stale revision is refused, never merged.',
];

/** The one write an external party (R4) may reach, and then only in the client audience. */
const EXTERNAL_WRITES: ReadonlySet<string> = new Set(['task.comment']);

const EXTERNAL_FIXES: readonly string[] = [
  'A person without a membership may read what was shared with them and nothing more.',
  'Ask an administrator of this business for a membership to do this.',
];

const NOT_FOUND_FIXES: readonly string[] = [
  'Check the identifier against the one you were given.',
  'If you believe it exists, ask someone who can already see it to share it with you.',
];

/** The revision a targeted request named, or nothing. Absent on the untargeted ones. */
export function expectedRevisionOf(request: CommandRequest): number | undefined {
  return 'expectedRevision' in request ? request.expectedRevision : undefined;
}

/**
 * The fields of a request that name a record. Each one is cast to `uuid`
 * somewhere downstream — the authority check casts the scope, the rank query
 * casts an array of neighbours — and a cast raises rather than refusing. A
 * review found `recordId: 'not-a-uuid'` arriving as a fault with the chain
 * recording `failed`, where the contract promises a typed refusal.
 *
 * The list is explicit rather than derived from the field names, so a request
 * type that grows an identifier has to be added here rather than being
 * silently covered or silently missed.
 */
/**
 * The facts a caller may never state about their own request (D06).
 *
 * Every one of these is derived by the server: the business from the path and
 * the login mapping, the actor and the person from the resolved session, the
 * times from the server's clock, the revision from the record, and `source`
 * from the actor kind and the entry point. A body carrying one of them is a
 * body claiming a fact it is not in a position to know.
 *
 * **Why a typed refusal and not a quiet drop.** Dropping them and doing the
 * write anyway is what this boundary used to do, and the accepted ledger
 * (D06) requires a typed refusal and unchanged domain state instead. The
 * difference matters to the caller: a client that believed it had set
 * `actor_id` got a `200` and no correction, so the bug lived in the client and
 * the server looked fine. A refusal naming the keys is the only answer that
 * gets the field removed.
 *
 * **Why `FIELD_NOT_WRITABLE` and not `COMMAND_BODY_INVALID`.** The register
 * already spells this: "A payload carried a derived field", contract 4.3. The
 * body is well-formed JSON of well-formed keys, so calling it invalid would
 * send an author looking for a syntax mistake; what is wrong is that one of
 * its fields is the server's to write. `SOURCE_SPOOFED` stays what it is —
 * `tasks-write.ts` uses it for `source` *inside `fields`*, and for
 * `intake_state` there on create only (on update that is `TRANSITION_PROTECTED`
 * naming `task.triage`), where the mistake is claiming a provenance rather than
 * writing a derived value — and the two are told apart by where the key appears.
 *
 * The check is here, in the one place every command is prepared, rather than
 * in each handler. A rule held in one handler is a rule the next handler
 * forgets, and the four runtime commands added beside it inherit this one
 * without a line of their own.
 */
export const SYSTEM_OWNED_FIELDS: readonly string[] = [
  'actorId',
  'actor_id',
  'author',
  'authorActorId',
  'author_actor_id',
  'businessId',
  'business_id',
  'createdAt',
  'created_at',
  'entryPoint',
  'entry_point',
  'personId',
  'person_id',
  'postedAt',
  'posted_at',
  'revision',
  'source',
  'updatedAt',
  'updatedBy',
  'updatedByActorId',
  'updated_at',
  'updated_by_actor_id',
];

export const SYSTEM_OWNED_FIXES: readonly string[] = [
  'These fields are derived by the server and cannot be sent: remove them and send the request again.',
  'The business comes from the path, the actor and the person from your authenticated session, the times from the server clock, and the revision from the record.',
  'To write against a revision, send expected_revision. To be a different actor, sign in as one.',
];

/**
 * The system-owned keys one payload claims, sorted, or nothing.
 *
 * Exported because the read half needs the same answer and a second copy of
 * the list is a second thing to forget: `reads/dispatch.ts` applies this rule
 * to read payloads, which reach the server through a different envelope and
 * carry the same keys. It returns the keys and the values separately because
 * the two have different destinations — the keys are named in the refusal, the
 * values go only to the audit row (T1-N4) — and a helper that returned them
 * together would invite a caller to put both in the response.
 */
export function claimedSystemOwnedFields(
  payload: unknown,
):
  | { readonly keys: readonly string[]; readonly values: Readonly<Record<string, unknown>> }
  | undefined {
  const named = payload as Record<string, unknown>;
  if (typeof named !== 'object' || named === null) return undefined;
  const keys = SYSTEM_OWNED_FIELDS.filter((field) => field in named).toSorted();
  if (keys.length === 0) return undefined;
  return { keys, values: Object.fromEntries(keys.map((field) => [field, named[field]])) };
}

/**
 * The installed field keys whose write mode is `system`, across every live
 * field of every record type in the business.
 *
 * Read from `field_defs` rather than written out, because the installed
 * metadata is what says a field is the server's to write: `completed_at` and
 * `key` on the task, the comment's `task` and `edited_at`, the state's
 * `machine_category`, and whatever a preset later installs as `system`.
 * `SYSTEM_OWNED_FIELDS` is the envelope's facts, which are no field's; this is
 * the fields', and a hand-copied list of them is the drift root ruling 1 rules
 * out.
 */
const INSTALLED_SYSTEM_FIELDS = `
  select distinct key from public.field_defs
   where business_id = $1 and write_mode = 'system' and deactivated_at is null`;

/**
 * The system keys a request carries *at its top level*: the envelope's own
 * and every installed system field's (root ruling 1, D06-GENERATED F1).
 *
 * Only the top level. A key nested in an operand is that operand's business:
 * `fields.completed_at` is the field engine's refusal, `fields.source` stays
 * `SOURCE_SPOOFED`, and a plan's field definitions carry `key` by design. It
 * is not an unknown-key policy either: a key that is neither the envelope's
 * nor an installed system field is left to the operation, as before. An own
 * property only, so a field installed under a name `Object.prototype` also
 * has is not claimed by every body.
 *
 * Returned as `claimedSystemOwnedFields` returns, keys and values apart, for
 * the reason it gives.
 */
export async function claimedSystemFields(
  tx: TenantQuery,
  payload: unknown,
): Promise<
  | { readonly keys: readonly string[]; readonly values: Readonly<Record<string, unknown>> }
  | undefined
> {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const named = payload as Readonly<Record<string, unknown>>;
  const installed = await tx.query<{ readonly key: string }>(INSTALLED_SYSTEM_FIELDS, [
    tx.businessId,
  ]);
  const owned = new Set([...SYSTEM_OWNED_FIELDS, ...installed.map((row) => row.key)]);
  const keys = [...owned].filter((field) => Object.hasOwn(named, field)).toSorted();
  if (keys.length === 0) return undefined;
  return { keys, values: Object.fromEntries(keys.map((field) => [field, named[field]])) };
}

/**
 * A request naming a fact the server owns, refused before anything is read.
 *
 * It is first, before the identifier shape and before authority, for the same
 * reason the identifier check is early: nothing about the business has been
 * read yet, so a caller learns only that the field they sent is not theirs to
 * send — which is exactly what they need to know and nothing else. The
 * attempted values go to the audit event and never to the response (T1-N4).
 * The one statement it runs reads the business's own field metadata and
 * nothing about any record.
 */
async function refuseSystemOwnedFields(
  tx: TenantQuery,
  request: CommandRequest,
): Promise<Refused | undefined> {
  const claimed = await claimedSystemFields(tx, request);
  if (claimed === undefined) return undefined;
  return refused(
    refuseCommand('FIELD_NOT_WRITABLE', claimed.keys, SYSTEM_OWNED_FIXES),
    claimed.values,
  );
}

const IDENTIFIER_FIELDS: readonly string[] = [
  'recordId',
  'parentId',
  'batchId',
  'afterId',
  'beforeId',
  'board',
  'boardSection',
  'gateId',
  'versionId',
  'lineageId',
  'reservationId',
  'leaseId',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `NOT_FOUND`, and not a code that says "malformed".
 *
 * An identifier that cannot exist and an identifier that does not exist are
 * the same answer, and giving them different ones would tell a caller which
 * of their guesses were well formed.
 */
function refuseMalformedIdentifier(request: CommandRequest): Refused | undefined {
  const named = request as unknown as Record<string, unknown>;
  const malformed = shapedHere(request.command).filter((field) => {
    const value = named[field];
    return typeof value === 'string' && !UUID.test(value);
  });
  if (malformed.length === 0) return undefined;
  return refused(refuseCommand('NOT_FOUND', [], NOT_FOUND_FIXES));
}

const BODY_FIXES: readonly string[] = [
  'Send only the fields this command declares.',
  'A command that targets no existing record takes no record identifier.',
];

/**
 * The identifier fields each *untargeted* command actually declares, written
 * out for the same reason `IDENTIFIER_FIELDS` is: a request type that grows an
 * identifier has to be named here rather than being silently covered.
 *
 * Only the untargeted commands are listed, because they are the ones with no
 * record of their own to be confused with the one a body names. A targeted
 * command's `recordId` *is* its target and is checked by reading it.
 *
 * `task.pickup` and `task.handback` take a `recordId` and still declare no
 * existing target: neither writes the task, and neither has landed. When they
 * do, what their authority is checked against is a decision for the part that
 * lands them, not a field this table can infer.
 */
const UNTARGETED_IDENTIFIERS: Readonly<Record<string, readonly string[]>> = {
  'task.create': ['parentId', 'board', 'boardSection'],
  'task.decide': ['gateId', 'versionId'],
  'task.handback': ['leaseId'],
  'task.pickup': ['reservationId'],
  'task.purge': [],
  'task.restore': ['batchId'],
  // Neither settings command names a record. The setting is chosen by the
  // command, so a body carrying a `recordId` is a body the caller believes was
  // honoured and it is refused rather than dropped.
  'settings.set_client_sign_off': [],
  'settings.set_four_eyes_threshold': [],
};

/**
 * The identifier fields a body carries that its operation does not take.
 *
 * Exported for the read half, which asks the same question of its own
 * operations (`reads/dispatch.ts`, root ruling 3): one list of what counts as
 * an identifier, so a field added here is refused on both paths or neither.
 * `null` is a value the caller sent, so it counts as present.
 */
export function irrelevantIdentifiers(
  named: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): readonly string[] {
  return IDENTIFIER_FIELDS.filter(
    (field) => named[field] !== undefined && !allowed.includes(field),
  );
}

/**
 * A target field on a command that has no target.
 *
 * Refused and not ignored. Ignoring it is what let the field reach the
 * authority check while reaching nothing else, and a body whose identifier
 * the server quietly drops is a body the caller believes was honoured.
 */
function refuseIrrelevantTarget(
  request: CommandRequest,
  declaration: CommandDeclaration,
): Refused | undefined {
  if (declaration.targetsExistingRecord) return undefined;
  const allowed = UNTARGETED_IDENTIFIERS[declaration.name];
  if (allowed === undefined) return undefined;
  const irrelevant = irrelevantIdentifiers(request as unknown as Record<string, unknown>, allowed);
  if (irrelevant.length === 0) return undefined;
  return refused(refuseCommand('COMMAND_BODY_INVALID', irrelevant, BODY_FIXES));
}

/**
 * The scope a `target` command is authorised on: the revoked row's own. A
 * grant is asked about at the scope it was issued on and a delegation at its
 * purpose scope, so a manager whose `manage` covers exactly that scope reaches
 * the handler, which then asks the full ceiling (`authority-controls.ts`).
 * Read-only and unlocked, like every discovery read. A body naming no such row
 * is asked at business scope, so a caller holding nothing is still refused
 * `SCOPE_NOT_GRANTED` rather than told about the shape of its body.
 */
async function targetScopeOf(tx: TenantQuery, request: CommandRequest): Promise<Scope> {
  const named = request as unknown as Record<string, unknown>;
  const lookups: readonly (readonly [string, string])[] = [
    [
      'grantId',
      'select scope_kind as kind, scope_id as id from public.grants where business_id = $1 and id = $2',
    ],
    [
      'delegationId',
      'select purpose_scope_kind as kind, purpose_scope_id as id from public.delegations where business_id = $1 and id = $2',
    ],
  ];
  for (const [field, sql] of lookups) {
    const id = named[field];
    if (typeof id !== 'string' || !UUID.test(id)) continue;
    // eslint-disable-next-line no-await-in-loop -- at most one of the two is named
    const rows = await tx.query<Scope>(sql, [tx.businessId, id]);
    if (rows[0] !== undefined) return rows[0];
  }
  return { kind: 'business', id: null };
}

/**
 * The scope a `claim` command is authorised on: the task its reservation or
 * lease belongs to, asked at record scope as the runtime asks it under its
 * locks. Read-only and unlocked, like `targetScopeOf`. A body naming no such
 * row is asked at business scope, so a foreign and a fabricated id get one
 * answer and a caller holding nothing is refused `SCOPE_NOT_GRANTED`.
 */
async function claimScopeOf(tx: TenantQuery, request: CommandRequest): Promise<Scope> {
  const named = request as unknown as Record<string, unknown>;
  const lookups: readonly (readonly [string, string])[] = [
    [
      'reservationId',
      `select run.task_id as id
         from public.reservations res
         join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
        where res.business_id = $1 and res.id = $2`,
    ],
    ['leaseId', 'select task_id as id from public.leases where business_id = $1 and id = $2'],
  ];
  for (const [field, sql] of lookups) {
    const id = named[field];
    if (typeof id !== 'string' || !UUID.test(id)) continue;
    // eslint-disable-next-line no-await-in-loop -- at most one of the two is named
    const rows = await tx.query<{ readonly id: string }>(sql, [tx.businessId, id]);
    if (rows[0] !== undefined) return { kind: 'record', id: rows[0].id };
  }
  return { kind: 'business', id: null };
}

/** Everything the handler needs first, or the refusal that stops it. */
export async function prepareCommand(
  tx: TenantQuery,
  session: Session,
  entryPoint: EntryPoint,
  request: CommandRequest,
  declaration: CommandDeclaration,
): Promise<CommandContext | Refused> {
  const spoofed = await refuseSystemOwnedFields(tx, request);
  if (spoofed !== undefined) return spoofed;
  const malformed = refuseMalformedIdentifier(request);
  if (malformed !== undefined) return malformed;

  const irrelevant = refuseIrrelevantTarget(request, declaration);
  if (irrelevant !== undefined) return irrelevant;

  const spine = await readTaskSpine(tx);

  // The scope comes from the declaration's `authorisedOn`, not from whether
  // the command revises its target: a command naming a task is checked
  // against that task, a business command against the business, whatever
  // identifiers its body happens to carry, and a `target` command is left to
  // its handler, which asks the resolved row's own ceiling.
  const recordId =
    'recordId' in request && typeof request.recordId === 'string' ? request.recordId : undefined;
  // R4 before any grant row. A session with no membership stands on a read
  // share, and whatever else a row may say it holds, it writes nothing but a
  // client-audience comment (minimum contract 8.1 R4; the audience is
  // `tasks-comment.ts`'s to narrow).
  if (session.roleKey === null && !EXTERNAL_WRITES.has(declaration.name)) {
    return refused(refuseCommand('SCOPE_NOT_GRANTED', [], EXTERNAL_FIXES));
  }
  const authorised = await checkAuthority(tx, subjectsOf(session), {
    // From the declaration, never written in here: see `CommandDeclaration`.
    collection: declaration.collection,
    action: declaration.action,
    scope:
      declaration.authorisedOn === 'record' && recordId !== undefined
        ? { kind: 'record', id: recordId }
        : declaration.authorisedOn === 'target'
          ? await targetScopeOf(tx, request)
          : declaration.authorisedOn === 'claim'
            ? await claimScopeOf(tx, request)
            : { kind: 'business', id: null },
  });
  if (!authorised.ok) return refused(fromAuthority(authorised.refusal));

  let target: TaskRow | undefined;
  if (declaration.targetsExistingRecord) {
    // F1. A target the runtime locks in its own order is only read here. The
    // read takes nothing, and the handler compares the revision under the
    // runtime's locks; locking it here would be a task lock held before the
    // cap and envelope the runtime then asks for.
    target = await lockTask(tx, spine.taskTypeId, recordId ?? '', {
      forUpdate: declaration.targetLock === 'command',
    });
    if (target === undefined) {
      // Not there, or there in another business: one answer, deliberately.
      return refused(refuseCommand('NOT_FOUND', [], NOT_FOUND_FIXES));
    }
    if (declaration.targetLock === 'command' && expectedRevisionOf(request) !== target.revision) {
      return refused(
        refuseCommand('VERSION_STALE', [`revision=${target.revision}`], REVISION_FIXES),
      );
    }
  }

  return { session, declaration, entryPoint, spine, target };
}

/**
 * The tenant half of `lockTask`'s filter.
 *
 * A constant, and the anchor I14's mutation proof edits. That proof copies
 * this package's source to a disposable directory, replaces this one line in
 * the copy with a condition that binds the same parameter and filters
 * nothing, and runs the copy's own `lockTask` and command path against a real
 * database (`tests/support/source-mutant.ts`, `tests/tenancy/production-lookup.test.ts`).
 * So the statement below is the one under test, and the shipped module has no
 * way to change its tenant filter at run time.
 */
const TENANT_PREDICATE = 'business_id = $1';

/**
 * The target, held for the rest of the transaction.
 *
 * `for update` is the whole of the lost-update fix. A second caller presenting
 * the same `expectedRevision` blocks here until the first transaction ends,
 * and then — read committed being this server's default — re-reads the row as
 * the first committed it, revision and all. So the comparison in
 * `prepareCommand` runs against the revision the record is actually at rather
 * than the one it was at when the second caller started, and the loser is
 * refused instead of overwriting the winner.
 *
 * A row the first transaction deleted no longer matches, the read returns
 * nothing, and the second caller gets `NOT_FOUND` — which is the same answer
 * it would have got a moment later anyway.
 */
export async function lockTask(
  tx: TenantQuery,
  taskTypeId: string,
  recordId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<TaskRow | undefined> {
  if (!UUID.test(recordId)) return undefined;
  // `revision` is `bigint`, and this driver hands a bigint back as a string.
  // It is read as text and converted once, here, so no command has to know
  // that and none of them compares a number against a string.
  const rows = await tx.query<Omit<TaskRow, 'revision'> & { readonly revision: string }>(
    `select id, revision::text as revision, data, deleted_at, trash_batch_id
       from records
      where ${TENANT_PREDICATE} and record_type_id = $2 and id = $3
        ${options.forUpdate === false ? '' : 'for update'}`,
    [tx.businessId, taskTypeId, recordId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { ...row, revision: Number(row.revision) };
}

/**
 * The runtime handlers shape their own operand (`isIdentifier`, called from
 * `tasks-runtime.ts`) and answer a malformed one in their own code,
 * RESERVATION_NOT_CLAIMABLE or LEASE_NOT_OWNED, byte for byte as they answer
 * a fabricated one. A generic NOT_FOUND here told the two apart; the agent
 * envelope, which never comes through here, reached SQL and faulted. Any
 * other command naming these fields is still answered here.
 */
const RUNTIME_SHAPED: Readonly<Record<string, string>> = {
  'task.pickup': 'reservationId',
  'task.heartbeat': 'leaseId',
  'task.handback': 'leaseId',
};

/** The identifier fields `refuseMalformedIdentifier` shapes for this command. */
function shapedHere(command: string): readonly string[] {
  const own = RUNTIME_SHAPED[command];
  return IDENTIFIER_FIELDS.filter((field) => field !== own);
}
