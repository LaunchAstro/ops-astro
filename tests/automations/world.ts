// SPDX-License-Identifier: AGPL-3.0-only
//
// One world for C33's records cases: a fresh database, two businesses, a
// person in each, and one automation definition in the first whose name
// carries a canary. Occurrences are claimed by the scheduler and the event
// intake under the worker lease (AW-01, not built), so the world claims
// through the application role in the business's own transaction, as the
// worker will. Each business has an active worker, whose actor starts an
// occurrence's run (AW-01 J), and the task spine that run's task lands on.

import { randomUUID } from 'node:crypto';
import {
  claimOccurrence,
  insertActivation,
  insertDefinition,
  releaseVersion,
  type ActivationMode,
  type ActivationRow,
  type DefinitionVersionRow,
  type OccurrenceCause,
  type OccurrenceClaim,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { enrol, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';

export const DIGEST: string = 'a'.repeat(64);

export interface AutomationWorld {
  readonly db: FreshDatabase;
  readonly alpha: string;
  readonly bravo: string;
  readonly admin: Member;
  readonly bravoAdmin: Member;
  readonly worker: string;
  readonly bravoWorker: string;
  readonly definition: string;
  readonly canary: string;
  inAlpha<T>(run: (tx: TenantQuery) => Promise<T>): Promise<T>;
  count(sql: string, params?: readonly unknown[]): Promise<number>;
  release(modes: readonly ActivationMode[]): Promise<DefinitionVersionRow>;
  activate(
    version: DefinitionVersionRow,
    mode: ActivationMode,
    enabled?: boolean,
  ): Promise<ActivationRow>;
  claim(activationId: string, cause: OccurrenceCause): Promise<OccurrenceClaim>;
  occurrences(activationId: string): Promise<number>;
}

/** An actor of the business's own worker, active unless asked otherwise. */
export async function insertWorker(
  db: FreshDatabase,
  business: string,
  active = true,
): Promise<string> {
  const id = randomUUID();
  await db.admin.execute(
    `insert into public.actors (business_id, id, kind, active, deactivated_at)
     values ($1, $2, 'worker', $3, case when $3 then null else now() end)`,
    [business, id, active],
  );
  return id;
}

// eslint-disable-next-line max-lines-per-function -- the world and its helpers, built in one place
export async function createAutomationWorld(part: string): Promise<AutomationWorld> {
  const db = await createFreshDatabase({ part });
  const alpha = await insertBusiness(db.app, 'alpha');
  const bravo = await insertBusiness(db.app, 'bravo');
  const admin = await enrol(db.app, alpha, 'admin');
  const bravoAdmin = await enrol(db.app, bravo, 'bravoadmin');
  const worker = await insertWorker(db, alpha);
  const bravoWorker = await insertWorker(db, bravo);
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  const canary = `c33-canary-${randomUUID()}`;
  const inAlpha = async <T>(run: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await db.app.withBusiness(alpha, run);
  const definition = await inAlpha((tx) =>
    insertDefinition(tx, {
      kind: 'automation',
      name: `Weekly report ${canary}`,
      actorId: admin.actorId,
    }),
  );
  const count = async (sql: string, params: readonly unknown[] = []): Promise<number> => {
    const rows = await db.admin.execute<{ readonly n: string }>(sql, params);
    return Number(rows[0]?.n);
  };

  return {
    db,
    alpha,
    bravo,
    admin,
    bravoAdmin,
    worker,
    bravoWorker,
    definition,
    canary,
    inAlpha,
    count,
    async release(modes) {
      const version = await inAlpha((tx) =>
        releaseVersion(tx, {
          definitionId: definition,
          contentDigest: DIGEST,
          contentSize: 1234,
          inputs: [{ name: 'client', kind: 'id' }],
          operations: ['report.send'],
          modes,
          actorId: admin.actorId,
        }),
      );
      if (version === null || version === 'raced') throw new Error(`release answered ${version}`);
      return version;
    },
    async activate(version, mode, enabled = true) {
      const row = await inAlpha((tx) =>
        insertActivation(tx, {
          versionId: version.id,
          mode,
          everyMinutes: mode === 'scheduled' ? 60 : null,
          eventKind: mode === 'event' ? 'invoice.paid' : null,
          enabled,
          actorId: admin.actorId,
        }),
      );
      if (row === null) throw new Error('the activation was not written');
      return row;
    },
    async claim(activationId, cause) {
      return await inAlpha((tx) => claimOccurrence(tx, activationId, cause));
    },
    async occurrences(activationId) {
      return await count(
        'select count(*) as n from public.activation_occurrences where activation_id = $1',
        [activationId],
      );
    },
  };
}
