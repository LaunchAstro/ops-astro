// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  noDatabase,
  REFERENCES,
  useUpgrade,
  hostileRow,
  conversationRow,
  rowFor,
  insertReference,
  refusedUpgrade,
} from './run-side-reference-fixture.ts';

useUpgrade();
describe.skipIf(noDatabase)('run-reference upgrades refuse inconsistent history', () => {
  it.each(REFERENCES)('preserves history when %s has an out-of-scope %s', async (table, column) => {
    await expect(
      insertReference(table, await hostileRow(table, column), true),
    ).resolves.toBeUndefined();
    await refusedUpgrade(`${table}.${column}`);
  });
  it('preserves an orphaned conversation call and stops the upgrade', async () => {
    await insertReference('model_calls', conversationRow(randomUUID()), true);
    await refusedUpgrade('model_calls.conversation_id');
  });
  it('preserves an orphaned outcome person and stops the upgrade', async () => {
    await insertReference(
      'model_calls',
      { ...rowFor('model_calls'), outcome_person_id: randomUUID() },
      true,
    );
    await refusedUpgrade('model_calls.outcome_person_id');
  });
});
