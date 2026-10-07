// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  noDatabase,
  REFERENCES,
  useReferences,
  rowFor,
  hostileRow,
  conversationRow,
  insertReference,
} from './run-side-reference-fixture.ts';

useReferences();
describe.skipIf(noDatabase)('run-side references keep their scope', () => {
  it.each(REFERENCES)(
    '%s refuses an out-of-scope %s as the application role',
    async (table, column) => {
      await expect(insertReference(table, await hostileRow(table, column))).rejects.toMatchObject({
        code: '23503',
      });
    },
  );
  it.each(['attempts', 'handback_reports', 'run_events', 'outage_runs', 'model_calls'])(
    '%s accepts references within the same run as the application role',
    async (table) => {
      await expect(insertReference(table, rowFor(table))).resolves.toBeUndefined();
    },
  );
  it('accepts its own business conversation without run references', async () => {
    await expect(insertReference('model_calls', conversationRow())).resolves.toBeUndefined();
  });
});
