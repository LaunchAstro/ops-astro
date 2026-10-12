// SPDX-License-Identifier: AGPL-3.0-only
//
// A read takes the identifiers its catalogue row names and refuses every other
// one, the read's own identifiers (person, client, runId, attemptId, incidentId,
// correctionId) as well as the commands' list, `COMMAND_BODY_INVALID` naming
// it and answering nothing. Before, only the commands' list was checked and the
// read's parse dropped the rest, so a caller asking for one run or one client
// got a 200 about something else.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { READ_BODY_FIXES } from '../../packages/core-commands/src/reads/dispatch.ts';
import type { ReadRequest } from '../../packages/core-commands/src/reads/requests.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
let db: FreshDatabase;
let business: BusinessId;
let member: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'ri' });
  business = (await insertBusiness(db.app, 'read-identifiers')) as BusinessId;
  await installSpine(db.app, business);
  member = await enrol(db.app, business, 'member');
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, member, 'read');
  });
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

const ask = async (request: Readonly<Record<string, unknown>>) =>
  await executeRead(db.app, business, member.presented, request as unknown as ReadRequest);

/** The refusal and nothing else: no content beside it. */
const bodyInvalid = (field: string) => ({
  refused: true,
  code: 'COMMAND_BODY_INVALID',
  names: [field],
  fixes: READ_BODY_FIXES,
});

/** The member's refused audit rows for this read, newest last. */
const refusedRows = async (read: string): Promise<readonly string[]> =>
  (
    await db.admin.execute<{ readonly code: string }>(
      `select refusal_code as code from public.audit_events
        where business_id = $1 and actor_id = $2 and command = $3 and outcome = 'refused'
        order by seq`,
      [business, member.actorId, read],
    )
  ).map((row) => row.code);

const READ_IDENTIFIERS = ['person', 'client', 'runId', 'attemptId', 'incidentId', 'correctionId'];

it.skipIf(serverUrl === undefined)(
  'a read that takes no identifier refuses each read identifier by name and answers nothing',
  async () => {
    for (const field of READ_IDENTIFIERS) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await ask({ read: 'task.search', query: 'anything', [field]: randomUUID() });
      expect(answer, field).toStrictEqual(bodyInvalid(field));
    }
    expect(await refusedRows('task.search')).toStrictEqual(
      READ_IDENTIFIERS.map(() => 'COMMAND_BODY_INVALID'),
    );
  },
  120_000,
);

it.skipIf(serverUrl === undefined)('a null read identifier counts as sent', async () => {
  const answer = await ask({ read: 'task.search', query: 'anything', client: null });
  expect(answer).toStrictEqual(bodyInvalid('client'));
});

it.skipIf(serverUrl === undefined)(
  'a run or incident read refuses the identifier the other one takes',
  async () => {
    expect(
      await ask({ read: 'harness.read', runId: randomUUID(), incidentId: randomUUID() }),
    ).toStrictEqual(bodyInvalid('incidentId'));
    expect(
      await ask({ read: 'task.receipt', attemptId: randomUUID(), runId: randomUUID() }),
    ).toStrictEqual(bodyInvalid('runId'));
    expect(await refusedRows('harness.read')).toContain('COMMAND_BODY_INVALID');
    expect(await refusedRows('task.receipt')).toContain('COMMAND_BODY_INVALID');
  },
);

it.skipIf(serverUrl === undefined)('the identifiers a read declares still reach it', async () => {
  const search = await ask({ read: 'task.search', query: 'anything' });
  expect(search).not.toHaveProperty('refused');
  const todos = await ask({ read: 'task.todos', person: randomUUID() });
  expect(todos).not.toMatchObject({ code: 'COMMAND_BODY_INVALID' });
  const harness = await ask({ read: 'harness.read', runId: randomUUID() });
  expect(harness).not.toMatchObject({ code: 'COMMAND_BODY_INVALID' });
});
