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

  const spine = await readTaskSpine(tx);

  const authorised = await checkAuthority(tx, subjectsOf(session), {
    collection: 'task',
    action: declaration.action,
    scope:
      'recordId' in request && typeof request.recordId === 'string'
        ? { kind: 'record', id: request.recordId }
        : { kind: 'business', id: null },
  });
  if (!authorised.ok) return refused(fromAuthority(authorised.refusal));

  let target: TaskRow | undefined;
  if (declaration.targetsExistingRecord) {
    const recordId = 'recordId' in request ? request.recordId : '';
    target = await readTask(tx, spine.taskTypeId, recordId);
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

async function readTask(
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
      where business_id = $1 and record_type_id = $2 and id = $3`,
    [tx.businessId, taskTypeId, recordId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { ...row, revision: Number(row.revision) };
}
