// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';
import { clientOne, api, rows, task, useIsolationWorld } from './api-1-isolation-world.ts';
import { foreign, threeWays } from './api-1-isolation-surfaces.ts';

useIsolationWorld();

it('a leaked client read is visible to the isolation assertion', async () => {
  const row = rows.find((one) => one.command === 'task.read');
  if (row === undefined) throw new Error('task.read is missing from the catalogue');
  const leaked = vi.spyOn(api, 'fetch').mockImplementation(() =>
    Promise.resolve(
      Response.json({ recordId: task.client2, fields: { title: 'other client secret' } }),
    ),
  );
  try {
    const heard = await threeWays(row, clientOne, 'alpha', { recordId: task.client1 });
    expect(heard.map((one) => one.status)).toEqual([200, 200, 200]);
    expect(foreign(heard, 'client1')).toEqual(['client2']);
    expect(JSON.stringify(heard)).toContain(task.client2);
  } finally {
    leaked.mockRestore();
  }
});
