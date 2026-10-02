// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-4's preference legs (CS-4.27, `preference saved`, not audited): showing
// or hiding a task's finished subtasks is the person's own key in the one
// preference store (MP-2-11a), `subtasks.showFinished`. Hidden, the default,
// is the absence of a row. Through the real API on a throwaway database.

import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  ada,
  adaToken,
  auditCount,
  ben,
  benToken,
  CANARY,
  expectNoCanary,
  read,
  rowsOf,
  save,
  usePreferencesWorld,
} from './preferences-world.ts';

const serverUrl = databaseUrlFromEnvironment();
const KEY = 'subtasks.showFinished';

describe.skipIf(serverUrl === undefined)('MP-4-4 show finished, per person', () => {
  usePreferencesWorld('mp44pref');

  it('MP-4-4 no audit for preferences: showing and hiding finished subtasks is saved, and adds no audit event', async () => {
    const before = await auditCount(ada.actorId);
    const shown = await save(KEY, true, adaToken);
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(await read(adaToken)).toMatchObject({ [KEY]: true });
    expect((await save(KEY, false, adaToken)).status).toBe(200);
    expect(await read(adaToken)).toMatchObject({ [KEY]: false });
    expect(await auditCount(ada.actorId)).toBe(before);
  });

  it('MP-4-4 show finished takes true or false and nothing else', async () => {
    for (const value of ['yes', 1, null, {}]) {
      // eslint-disable-next-line no-await-in-loop -- one save at a time
      const answer = await save(KEY, value, benToken);
      expect(answer.status, JSON.stringify(value)).not.toBe(200);
    }
    expect(await rowsOf(ben.personId)).toStrictEqual([]);
  });

  it('MP-4-4 own preference only: a show-finished save naming another person is refused and writes nothing', async () => {
    const aimed = await save(KEY, true, benToken, { personId: ada.personId });
    expect(aimed.status).not.toBe(200);
    expectNoCanary(aimed);
    expect(await rowsOf(ben.personId)).toStrictEqual([]);
    // Ada's row holds only what Ada saved.
    const adas = await rowsOf(ada.personId);
    expect(adas.find((row) => row.key === KEY)?.value).toBe(false);
    expect(adas.find((row) => row.key === 'columns.widths')?.value).toStrictEqual({
      [CANARY]: 111,
    });
  });
});
