// SPDX-License-Identifier: AGPL-3.0-only
//
// One migrated template per run (CI-SPEED, NATHAN-CF-RECORD item 1). Not built yet:
// the signatures its proofs (migrated-template.test.ts) are written against.

import type { MigrationOutcome } from '../../packages/core-records/src/tenancy/migrate.ts';

/** `off` makes every fresh database migrate from empty, as before the template. */
export const TEMPLATE_SWITCH = 'OPS_ASTRO_DB_TEMPLATE';

export interface MigratedTemplate {
  readonly name: string;
  readonly migration: MigrationOutcome;
}

export function templateEnabled(): boolean {
  return false;
}

export function templateName(_migrationsDirectory = 'migrations'): string {
  return 'migrated_0000000000000000';
}

export function ensureMigratedTemplate(
  _serverUrl: string,
  name: string = templateName(),
): Promise<MigratedTemplate> {
  return Promise.resolve({ name, migration: { applied: [], alreadyApplied: [] } });
}
