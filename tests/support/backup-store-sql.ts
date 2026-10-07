// SPDX-License-Identifier: AGPL-3.0-only
//
// The backup store as the restore runbook makes it: deploy/staging/
// backup-store.sql, then each numbered backup-store-upgrade-<n>.sql in
// order (deploy/staging/README.md). Each rule lives in one file, so a store
// made before an upgrade and a new one end up the same.

import { readdirSync, readFileSync } from 'node:fs';

const STAGING = new URL('../../deploy/staging/', import.meta.url);

/** The numbered upgrades, in order. */
export function storeUpgrades(): string[] {
  return readdirSync(STAGING)
    .map((name) => ({ name, n: /^backup-store-upgrade-(\d+)\.sql$/u.exec(name)?.[1] }))
    .filter((file): file is { name: string; n: string } => file.n !== undefined)
    .toSorted((a, b) => Number(a.n) - Number(b.n))
    .map(({ name }) => readFileSync(new URL(name, STAGING), 'utf8'));
}

/** The whole store, install and upgrades, as one script. */
export function backupStoreSql(): string {
  return [readFileSync(new URL('backup-store.sql', STAGING), 'utf8'), ...storeUpgrades()].join(
    '\n',
  );
}
