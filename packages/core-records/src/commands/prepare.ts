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
import { checkAuthority, subjectsOf } from '../authority/grants.ts';
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
const IDENTIFIER_FIELDS: readonly string[] = [
  'recordId',
  'parentId',
  'batchId',
  'afterId',
  'beforeId',
  'board',
  'boardSection',
  'gateInstanceId',
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
  const malformed = IDENTIFIER_FIELDS.filter((field) => {
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
  'task.decide': ['gateInstanceId'],
  'task.handback': ['recordId'],
  'task.pickup': ['recordId'],
  'task.purge': [],
  'task.restore': ['batchId'],
  // Neither settings command names a record. The setting is chosen by the
  // command, so a body carrying a `recordId` is a body the caller believes was
  // honoured and it is refused rather than dropped.
  'settings.set_client_sign_off': [],
  'settings.set_four_eyes_threshold': [],
};

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
  const named = request as unknown as Record<string, unknown>;
  const irrelevant = IDENTIFIER_FIELDS.filter(
    (field) => named[field] !== undefined && !allowed.includes(field),
  );
  if (irrelevant.length === 0) return undefined;
  return refused(refuseCommand('COMMAND_BODY_INVALID', irrelevant, BODY_FIXES));
}

/** Everything the handler needs first, or the refusal that stops it. */
export async function prepareCommand(
  tx: TenantQuery,
  session: Session,
  entryPoint: EntryPoint,
  request: CommandRequest,
  declaration: CommandDeclaration,
): Promise<CommandContext | Refused> {
  const malformed = refuseMalformedIdentifier(request);
  if (malformed !== undefined) return malformed;

  const irrelevant = refuseIrrelevantTarget(request, declaration);
  if (irrelevant !== undefined) return irrelevant;

  const spine = await readTaskSpine(tx);

  // The scope comes from the declaration. A command that targets an existing
  // record is checked against that record; every other command is checked
  // against the business, whatever identifiers its body happens to carry.
  const recordId =
    'recordId' in request && typeof request.recordId === 'string' ? request.recordId : undefined;
  const authorised = await checkAuthority(tx, subjectsOf(session), {
    // From the declaration, never written in here: see `CommandDeclaration`.
    collection: declaration.collection,
    action: declaration.action,
    scope:
      declaration.targetsExistingRecord && recordId !== undefined
        ? { kind: 'record', id: recordId }
        : { kind: 'business', id: null },
  });
  if (!authorised.ok) return refused(fromAuthority(authorised.refusal));

  let target: TaskRow | undefined;
  if (declaration.targetsExistingRecord) {
    target = await lockTask(tx, spine.taskTypeId, recordId ?? '');
    if (target === undefined) {
      // Not there, or there in another business: one answer, deliberately.
      return refused(refuseCommand('NOT_FOUND', [], NOT_FOUND_FIXES));
    }
    if (expectedRevisionOf(request) !== target.revision) {
      return refused(
        refuseCommand('VERSION_STALE', [`revision=${target.revision}`], REVISION_FIXES),
      );
    }
  }

  return { session, declaration, entryPoint, spine, target };
}

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
async function lockTask(
  tx: TenantQuery,
  taskTypeId: string,
  recordId: string,
): Promise<TaskRow | undefined> {
  if (!UUID.test(recordId)) return undefined;
  // `revision` is `bigint`, and this driver hands a bigint back as a string.
  // It is read as text and converted once, here, so no command has to know
  // that and none of them compares a number against a string.
  const rows = await tx.query<Omit<TaskRow, 'revision'> & { readonly revision: string }>(
    `select id, revision::text as revision, data, deleted_at, trash_batch_id
       from records
      where business_id = $1 and record_type_id = $2 and id = $3
        for update`,
    [tx.businessId, taskTypeId, recordId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { ...row, revision: Number(row.revision) };
}
