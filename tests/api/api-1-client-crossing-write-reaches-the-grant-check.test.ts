// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { clientOne, rows, task, useIsolationWorld } from './api-1-isolation-world.ts';
import { threeWays } from './api-1-isolation-surfaces.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('API-1 refusal cause', () => {
  useIsolationWorld();
  it('API-1 isolation: a client-to-client task.create reaches the grant check on every surface', async () => {
    const row = rows.find((entry) => entry.command === 'task.create');
    if (row === undefined) throw new Error('task.create is missing from the catalogue');
    const answers = await threeWays(row, clientOne, 'alpha', { recordId: task.client2 });
    expect(answers).toHaveLength(3);
    expect(answers.map(({ code }) => code)).toEqual([
      'SCOPE_NOT_GRANTED',
      'SCOPE_NOT_GRANTED',
      'SCOPE_NOT_GRANTED',
    ]);
  });
});
