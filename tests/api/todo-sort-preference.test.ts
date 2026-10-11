// SPDX-License-Identifier: AGPL-3.0-only
//
// U113 (MP-7-1, CS-7.24): the to-do list's sort is the person's own key in
// the one preference store, `todos.sort`, saved with `preference saved` (not
// audited). It takes one column and one direction and nothing else, reaches
// only the caller's own row in the caller's own business, and opens no agent
// route. Through the real API on a throwaway database.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { tokenFor } from './fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  ada,
  adaToken,
  auditCount,
  ben,
  benToken,
  call,
  expectNoCanary,
  fixture,
  read,
  rowsOf,
  save,
  usePreferencesWorld,
} from './preferences-world.ts';

const KEY = 'todos.sort';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('the to-do sort, per person', () => {
  usePreferencesWorld('todosort');

  it('a sort is saved and read back as the person’s own key, a replay changes nothing, and no audit event is added', async () => {
    const before = await auditCount(ada.actorId);
    const body = {
      operationId: randomUUID(),
      preference: KEY,
      value: { key: 'priority', direction: 'desc' },
    };
    const first = await call('preference.save', body, adaToken);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await call('preference.save', body, adaToken)).toStrictEqual(first);
    expect(await auditCount(ada.actorId)).toBe(before);
    expect((await read(adaToken))[KEY]).toStrictEqual(body.value);
    expect((await rowsOf(ada.personId)).filter((row) => row.key === KEY)).toHaveLength(1);
  });

  it(
    'a sort outside the closed shape is refused and the stored sort is unchanged',
    outsideTheShape,
  );

  it(
    'another person reads none of it, and a save naming the first person writes nothing of theirs',
    peopleApart,
  );

  it('the agent path does not take a sort save', async () => {
    const before = await rowsOf(ada.personId);
    const body = {
      operationId: randomUUID(),
      preference: KEY,
      value: { key: 'due', direction: 'asc' },
    };
    const answer = await call('preference.save', body, adaToken, { agent: true });
    expect(answer.status).not.toBe(200);
    expect(await rowsOf(ada.personId)).toStrictEqual(before);
  });

  it(
    'another business keeps its own sort, and neither business reaches the other’s',
    businessesApart,
  );
});

async function businessesApart(): Promise<void> {
  const bravo = await insertBusiness(fixture.db.app, 'sortbravo');
  await installSpine(fixture.db.app, bravo);
  const bruno = await enrol(fixture.db.app, bravo, 'Bruno Sort');
  await fixture.db.app.withBusiness(bravo, async (tx) => await grantTo(tx, bruno, 'read'));
  const token = await tokenFor(bruno.presented.subject);
  const before = await rowsOf(ada.personId);

  const across = await save(KEY, { key: 'due', direction: 'desc' }, token);
  expect(across.status).not.toBe(200);
  expectNoCanary(across);
  const own = await call(
    'preference.save',
    { operationId: randomUUID(), preference: KEY, value: { key: 'due', direction: 'desc' } },
    token,
    { key: 'sortbravo' },
  );
  expect(own.status).toBe(200);
  expect((await read(token, 'sortbravo'))[KEY]).toStrictEqual({ key: 'due', direction: 'desc' });
  const adaAcross = await call('preference.read', {}, adaToken, { key: 'sortbravo' });
  expect(adaAcross.status).not.toBe(200);
  expectNoCanary(adaAcross);
  expect(await rowsOf(ada.personId)).toStrictEqual(before);
}

async function outsideTheShape(): Promise<void> {
  const before = await rowsOf(ada.personId);
  for (const value of [
    { key: 'task', direction: 'sideways' },
    { key: 'colour', direction: 'asc' },
    { key: 'task' },
    { key: 'task', direction: 'asc', personId: ben.personId },
    'task',
  ]) {
    // eslint-disable-next-line no-await-in-loop -- one save at a time
    const answer = await save(KEY, value, adaToken);
    expect(answer.status, JSON.stringify(value)).toBe(422);
    expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
  }
  expect(await rowsOf(ada.personId)).toStrictEqual(before);
}

async function peopleApart(): Promise<void> {
  const bens = await call('preference.read', {}, benToken);
  expect(bens.status).toBe(200);
  expect(bens.body['preferences']).not.toHaveProperty(KEY);
  expectNoCanary(bens);
  const aimed = await save(KEY, { key: 'due', direction: 'asc' }, benToken, {
    personId: ada.personId,
  });
  expect(aimed.status).not.toBe(200);
  expectNoCanary(aimed);
  expect((await save(KEY, { key: 'task', direction: 'asc' }, benToken)).status).toBe(200);
  expect((await read(benToken))[KEY]).toStrictEqual({ key: 'task', direction: 'asc' });
  expect((await read(adaToken))[KEY]).toStrictEqual({ key: 'priority', direction: 'desc' });
}
