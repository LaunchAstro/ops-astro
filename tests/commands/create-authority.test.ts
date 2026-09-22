// SPDX-License-Identifier: AGPL-3.0-only
//
// What a record-scoped grant may do, and what it may not talk its way into.
//
// A review found `prepareCommand` deriving the authority target from
// `request.recordId` whenever the body carried one, without asking whether the
// command had a target at all. `task.create` targets no record, so a caller
// holding write on one record — and nothing else — was refused a plain create
// and then allowed the same create by adding the `recordId` of the record they
// did hold. The body chose what the server checked against, which is the one
// thing a caller's body must never do.
//
// The cases below are the ordinary ones on either side of that: a record-scoped
// grant updates its own record and not another, and cannot create at all; a
// business-scoped grant creates. The escalation itself is last, and it is now
// refused for the body rather than merely failing the check — an identifier a
// command has no use for is `COMMAND_BODY_INVALID` and not something the server
// quietly drops.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import type { CommandRequest } from '../../packages/core-records/src/commands/requests.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';

/** The refusal code, or `applied`: one string to assert a permission decision on. */
function codeOf(outcome: CommandResult): string {
  return isCommandRefusal(outcome) ? outcome.code : 'applied';
}

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('create-authority: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('the target a grant is checked against', () => {
  let db: FreshDatabase;
  let business: string;
  /** Holds write over the whole business: the ordinary author. */
  let author: Member;
  /** Holds write over one record and nothing else. */
  let narrow: Member;
  let granted: string;
  let other: string;

  const run = async (member: Member, request: CommandRequest): Promise<CommandResult> =>
    await executeCommand(db.app, business, member.presented, 'api', request);

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    business = await insertBusiness(db.app, 'create-authority');
    await installSpine(db.app, business);
    author = await enrol(db.app, business, 'author');
    narrow = await enrol(db.app, business, 'narrow');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, author, 'write');
    });

    const makeTask = async (title: string): Promise<string> => {
      const made = await run(author, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title },
      });
      if (isCommandRefusal(made)) throw new Error(`setup: create refused ${made.code}`);
      return made.recordId ?? '';
    };
    granted = await makeTask('the granted record');
    other = await makeTask('somebody else');

    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, narrow, 'write', { kind: 'record', id: granted });
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const revisionOf = async (recordId: string): Promise<number> => {
    const rows = await db.app.withBusiness(business, async (tx) =>
      tx.query<{ readonly revision: string }>(
        `select revision::text as revision from records where business_id = $1 and id = $2`,
        [business, recordId],
      ),
    );
    return Number(rows[0]?.revision ?? 0);
  };

  it('lets a business-wide grant create', async () => {
    const made = await run(author, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'an ordinary create' },
    });
    expect(codeOf(made)).toBe('applied');
  });

  it('lets a record-scoped grant update the record it names', async () => {
    const outcome = await run(narrow, {
      command: 'task.update',
      operationId: randomUUID(),
      recordId: granted,
      expectedRevision: await revisionOf(granted),
      fields: { title: 'edited by the holder' },
    });
    expect(codeOf(outcome)).toBe('applied');
  });

  it('refuses a record-scoped grant the record it does not name', async () => {
    const outcome = await run(narrow, {
      command: 'task.update',
      operationId: randomUUID(),
      recordId: other,
      expectedRevision: await revisionOf(other),
      fields: { title: 'not yours' },
    });
    expect(codeOf(outcome)).toBe('SCOPE_NOT_GRANTED');
  });

  it('refuses a record-scoped grant a plain create', async () => {
    const outcome = await run(narrow, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'no standing to create' },
    });
    expect(codeOf(outcome)).toBe('SCOPE_NOT_GRANTED');
  });

  it('refuses the create that borrows the granted record as its target', async () => {
    const outcome = await run(narrow, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'borrowed authority' },
      // Not in the shape `task.create` declares. It is here because this is
      // precisely what a caller sends, and before the fix it was enough.
      recordId: granted,
    } as unknown as CommandRequest);

    // The body is refused for being the wrong shape, which names the field the
    // caller has to drop. `SCOPE_NOT_GRANTED` would also have been safe; this
    // is better, because it tells the honest caller what was wrong.
    expect(codeOf(outcome)).toBe('COMMAND_BODY_INVALID');
    expect(isCommandRefusal(outcome) && outcome.names).toStrictEqual(['recordId']);

    // And nothing was written under the borrowed target.
    const rows = await db.app.withBusiness(business, async (tx) =>
      tx.query<{ readonly count: string }>(
        `select count(*)::text as count from records
          where business_id = $1 and data ->> 'title' = 'borrowed authority'`,
        [business],
      ),
    );
    expect(rows[0]?.count).toBe('0');
  });
});
