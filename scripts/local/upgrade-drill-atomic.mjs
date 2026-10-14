// SPDX-License-Identifier: AGPL-3.0-only
import { applyMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';

/**
 * Require the deployment's complete atomic run to succeed on the seeded data.
 * Roll it back so declaration predicates still get independent read-only
 * transactions at their boundaries. Only our successful rollback is caught.
 */
export async function proveAtomicUpgrade(admin, migrations) {
  const rollback = new Error('rollback the successful atomic upgrade proof');
  try {
    await admin.transaction(
      async (execute) => {
        await applyMigrations(
          { ...admin, execute, transaction: async (run) => await run(execute) },
          migrations,
        );
        throw rollback;
      },
      { oneCommandEach: true },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
