// SPDX-License-Identifier: AGPL-3.0-only
//
// The scheduled sweep entry (`apps/automations/sweep.ts`) over C33's world:
// its settings, firing on, with the world's application login and the
// business keys a case gives it. The world's owner login stands in for the
// lookup login, since the key lookup takes the lookup role on it. And an
// adopted one-minute activation in the first business, due every minute.

import { insertActivation } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { firingOf } from './firing.ts';
import type { AutomationWorld } from './world.ts';

/** The entry's settings for `w`, firing on, sweeping the businesses `keys` names. */
export function entrySettings(w: AutomationWorld, keys: string): Record<string, string> {
  const server = databaseUrlFromEnvironment();
  if (server === undefined) throw new Error('scheduled-entry: no test database server');
  const lookup = new URL(server);
  lookup.pathname = `/${w.db.name}`;
  return {
    AUTOMATION_FIRING: 'on',
    DATABASE_URL: w.db.appUrl,
    DATABASE_LOOKUP_URL: lookup.toString(),
    AUTOMATION_BUSINESS_KEYS: keys,
  };
}

/** A released, adopted one-minute activation in the first business; its id. */
export async function oneMinuteActivation(w: AutomationWorld): Promise<string> {
  const version = await w.release(['scheduled']);
  const activation = await w.inAlpha((tx) =>
    insertActivation(tx, {
      versionId: version.id,
      mode: 'scheduled',
      everyMinutes: 1,
      eventKind: null,
      enabled: true,
      actorId: w.admin.actorId,
    }),
  );
  if (activation === null) throw new Error('scheduled-entry: the activation was not written');
  await firingOf(w).adopt(activation, version);
  return activation.id;
}
