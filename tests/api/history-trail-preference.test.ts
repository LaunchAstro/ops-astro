// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's trail fold (`preference saved`, not audited) is the
// person's own key in the one preference store, `history.showTrail`. Folded,
// the default, is the absence of a row. Through the real API on a throwaway
// database.

import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  ada,
  adaToken,
  auditCount,
  ben,
  benToken,
  call,
  CANARY,
  expectNoCanary,
  read,
  rowsOf,
  save,
  usePreferencesWorld,
} from './preferences-world.ts';

const serverUrl = databaseUrlFromEnvironment();
const KEY = 'history.showTrail';

describe.skipIf(serverUrl === undefined)('the trail fold, per person', () => {
  usePreferencesWorld('histtrail');

  it('opening and folding the trail is saved as the person’s own key, and adds no audit event', async () => {
    const before = await auditCount(ada.actorId);
    const opened = await save(KEY, true, adaToken);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(await read(adaToken)).toMatchObject({ [KEY]: true });
    expect((await save(KEY, false, adaToken)).status).toBe(200);
    expect(await read(adaToken)).toMatchObject({ [KEY]: false });
    expect((await save(KEY, true, adaToken)).status).toBe(200);
    expect(await auditCount(ada.actorId)).toBe(before);
  });

  it('the trail fold takes true or false and nothing else', async () => {
    for (const value of ['open', 1, null, {}]) {
      // eslint-disable-next-line no-await-in-loop -- one save at a time
      const answer = await save(KEY, value, benToken);
      expect(answer.status, JSON.stringify(value)).not.toBe(200);
    }
    expect(await rowsOf(ben.personId)).toStrictEqual([]);
  });

  it('another person’s saved trail fold never reaches this person, and a save naming them writes nothing', async () => {
    const bens = await call('preference.read', {}, benToken);
    expect(bens.status, JSON.stringify(bens.body)).toBe(200);
    expect(bens.body['preferences']).not.toHaveProperty(KEY);
    expectNoCanary(bens);
    const aimed = await save(KEY, false, benToken, { personId: ada.personId });
    expect(aimed.status).not.toBe(200);
    expectNoCanary(aimed);
    expect(await rowsOf(ben.personId)).toStrictEqual([]);
    const adas = await rowsOf(ada.personId);
    expect(adas.find((row) => row.key === KEY)?.value).toBe(true);
    expect(adas.find((row) => row.key === 'columns.widths')?.value).toStrictEqual({
      [CANARY]: 111,
    });
  });
});
