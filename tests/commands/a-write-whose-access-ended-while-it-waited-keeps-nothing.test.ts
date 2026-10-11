// SPDX-License-Identifier: AGPL-3.0-only
//
// The envelope asks the caller's sign-in again after the command's last wait
// (OWNER-3 A). A person's own write asks no grant and takes no access lock, so
// an owner can end that person's access (C58) while the write waits on a row.
// Gus saves a preference while a fixture holds his preference row; Ada ends his
// access and it commits; then the fixture lets go. The save must be refused as
// the door now refuses Gus, `AUTH_ACCESS_ENDED`, and keep nothing: the value,
// the operation and the audit are as they were. A person who ends their own
// access keeps the act: the lost standing is the act itself.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;
let ada: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'standing_recheck' });
  alpha = await insertBusiness(db.app, 'alpha');
  await installSpine(db.app, alpha);
  ada = await manager('Ada Lane');
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const codeOf = (answer: CommandResult): string =>
  isCommandRefusal(answer) ? answer.code : 'applied';

const send = async (
  who: Member,
  body: Readonly<Record<string, unknown>>,
  database: Database = db.app,
): Promise<CommandResult> =>
  await executeCommand(database, alpha, who.presented, 'api', body as never);

async function manager(name: string): Promise<Member> {
  const member = await enrol(db.app, alpha, name);
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, member, 'manage', WHOLE_BUSINESS, false, 'access');
  });
  return member;
}

const save = (value: string) => ({
  command: 'preference.save',
  operationId: randomUUID(),
  preference: 'appearance',
  value,
});

/** What the operation left: its register rows and its applied audit events. */
async function kept(operationId: string): Promise<unknown> {
  const [row] = await db.admin.execute(
    `select (select count(*)::int from public.operations
              where business_id = $1 and operation_id = $2) as operations,
            (select count(*)::int from public.audit_events
              where business_id = $1 and operation_id = $2 and outcome = 'applied') as applied`,
    [alpha, operationId],
  );
  return row;
}

async function appearanceOf(person: Member): Promise<unknown> {
  const [row] = await db.admin.execute<{ readonly value: unknown }>(
    `select value from public.person_preferences
      where business_id = $1 and person_id = $2 and key = 'appearance'`,
    [alpha, person.personId],
  );
  return row?.value;
}

/** `body` sent by `who` while their preference row is held, with `meanwhile` run once it waits. */
async function waitingOnPreference(
  who: Member,
  body: Readonly<Record<string, unknown>>,
  meanwhile: () => Promise<void>,
): Promise<CommandResult> {
  const saver = connect(db.appUrl);
  try {
    const row = await hold(db.appUrl, alpha, async (tx) => {
      await tx.query(
        `select 1 from public.person_preferences
          where business_id = $1 and person_id = $2 and key = 'appearance' for update`,
        [tx.businessId, who.personId],
      );
    });
    let saving: Promise<CommandResult> | undefined;
    try {
      saving = send(who, body, saver);
      await waitingOn(db.admin, 'transactionid', 'person_preferences');
      await meanwhile();
    } finally {
      await row.letGo();
    }
    return await saving;
  } finally {
    await saver.close();
  }
}

it.skipIf(serverUrl === undefined)(
  'a preference saved while its access was ended is refused as ended, and keeps nothing',
  async () => {
    const gus = await enrol(db.app, alpha, 'Gus Reed');
    expect(codeOf(await send(gus, save('light')))).toBe('applied');
    const late = save('dark');
    const answer = await waitingOnPreference(gus, late, async () => {
      const body = { command: 'access.end', operationId: randomUUID(), holderId: gus.personId };
      expect(codeOf(await send(ada, body))).toBe('applied');
    });
    expect({
      answer: codeOf(answer),
      value: await appearanceOf(gus),
      kept: await kept(late.operationId),
    }).toStrictEqual({
      answer: 'AUTH_ACCESS_ENDED',
      value: 'light',
      kept: { operations: 0, applied: 0 },
    });
  },
);

it.skipIf(serverUrl === undefined)(
  'a manager who ends their own access keeps the act and its operation',
  async () => {
    const lea = await manager('Lea Moss');
    const body = { command: 'access.end', operationId: randomUUID(), holderId: lea.personId };
    expect(codeOf(await send(lea, body))).toBe('applied');
    expect(await kept(body.operationId)).toStrictEqual({ operations: 1, applied: 1 });
    expect(codeOf(await send(lea, body))).toBe('AUTH_ACCESS_ENDED');
  },
);
