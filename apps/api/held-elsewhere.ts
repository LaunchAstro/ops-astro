// SPDX-License-Identifier: AGPL-3.0-only
//
// The settings neither the hosted function (`function.ts`) nor the M5 mail
// unit (`apps/mail`) may hold: each belongs to another process, and holding
// it would put a login or key that reaches every business, a backup or the
// error sink in one that never needs it.

/**
 * The admin login, the sink's key, the provider's admin key (C58's endings
 * loop, `apps/endings`), the backup and restore credentials and the daily
 * upkeep's login (20261002105957): the environment machine's and the operator's.
 */
export const HELD_ELSEWHERE: readonly string[] = [
  'DATABASE_ADMIN_URL',
  'OPS_ERROR_SINK_DSN',
  'SUPABASE_SERVICE_KEY',
  'BACKUP_SOURCE_URL',
  'BACKUP_RETENTION_URL',
  'DATABASE_UPKEEP_URL',
  'BACKUP_STORE_URL',
  'RESTORE_STORE_URL',
  'RESTORE_KEY_FILE',
];
