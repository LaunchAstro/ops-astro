// SPDX-License-Identifier: AGPL-3.0-only
//
// The delegation-pairs migration, on a database that already holds
// delegations in 0008's product shape (`collections` x `actions`).
//
// ORCH25-SL12B-PAIRS: existing rows migrate to their exact pairs with no
// change in what they allow. Each row is written at the migration before it,
// as the application role, in every shape the old columns could hold; after
// the upgrade each live one is asked, call by call over every collection and
// action (`decide` among them), what `checkDelegatedAuthority` answers. Its
// purpose admits a pair exactly when the old product held it: an admitted pair
// goes on to the person's grants (none here, so `DELEGATION_NARROWED`), and
// every other pair stops at the purpose. A revoked row keeps its pairs too.
//
// The migration is found by name, so it keeps its place when it is renumbered.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDelegatedAuthority,
  resolveLiveById,
} from '../../packages/core-records/src/authority/delegations.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertBusiness,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/delegation-pairs-upgrade: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const onDisk = readMigrations('migrations');
const PAIRS = onDisk.find((m) => m.version.includes('delegation_pairs'))?.version ?? '';

const ACTIONS: readonly Action[] = [
  'read',
  'comment',
  'write',
  'assign',
  'share',
  'manage',
  'decide',
];

/** The product shapes 0008's columns could hold, one row each. */
const SHAPES: readonly { readonly collections: string[]; readonly actions: string[] }[] = [
  { collections: ['task'], actions: ['read', 'comment', 'write'] },
  { collections: ['task'], actions: ['read'] },
  { collections: ['task', 'preset'], actions: ['read', 'write', 'manage'] },
  { collections: ['settings', 'task', 'person'], actions: ['assign', 'share'] },
];
const REVOKED_SHAPE = { collections: ['task', 'preset'], actions: ['read', 'write', 'manage'] };
const COLLECTIONS = [...new Set([...SHAPES.flatMap((s) => s.collections), 'run', 'conversation'])];

const product = (shape: {
  readonly collections: readonly string[];
  readonly actions: readonly string[];
}): string[] => shape.collections.flatMap((c) => shape.actions.map((a) => `${c}:${a}`)).toSorted();

interface Seeded {
  readonly id: string;
  readonly agentActorId: string;
  readonly collections: readonly string[];
  readonly actions: readonly string[];
}

// eslint-disable-next-line max-lines-per-function -- one upgraded database, every row on it
describe.skipIf(serverUrl === undefined)(
  'delegation pairs, upgraded from the product shape',
  () => {
    let db: EmptyDatabase;
    let business: string;
    const live: Seeded[] = [];
    let revokedId = '';

    beforeAll(async () => {
      expect(PAIRS).not.toBe('');
      db = await createEmptyDatabase({ part: 'pairs_upgrade' });
      await applyMigrations(
        db.admin,
        onDisk.filter((m) => m.version < PAIRS),
      );
      business = await insertBusiness(db.app, 'alpha');
      await db.app.withBusiness(business, async (tx) => {
        const person = await insertPerson(tx, 'Ada');
        const actor = await insertActor(tx, person);
        await insertMembership(tx, person);
        const write = async (shape: (typeof SHAPES)[number], revoked: boolean): Promise<Seeded> => {
          const agentActorId = await insertAgentActor(tx);
          const id = randomUUID();
          await tx.query(
            `insert into public.delegations
             (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
              collections, actions, credential_hash, expires_at, purpose_scope_kind,
              purpose_scope_id, revoked_at)
           values ($1, $2, $3, $4, $5, 'old_shape', $6::text[], $7::text[], $8,
                   now() + interval '1 hour', 'record', $9, $10)`,
            [
              business,
              id,
              agentActorId,
              person,
              actor,
              shape.collections,
              shape.actions,
              randomUUID().replaceAll('-', '').repeat(2),
              randomUUID(),
              revoked ? new Date() : null,
            ],
          );
          return { id, agentActorId, ...shape };
        };
        for (const shape of SHAPES) {
          // oxlint-disable-next-line no-await-in-loop
          live.push(await write(shape, false));
        }
        revokedId = (await write(REVOKED_SHAPE, true)).id;
      });
      const migration = await migrate(db.admin, 'migrations');
      expect(migration.applied).toContain(PAIRS);
    }, 120_000);

    afterAll(async () => {
      await db?.drop();
    });

    it('product rows migrate to exact pairs', async () => {
      const rows = await db.admin.execute<{ readonly id: string; readonly pairs: string[] }>(
        `select id, pairs from public.delegations where business_id = $1`,
        [business],
      );
      const stored = new Map(rows.map((row) => [row.id, row.pairs.toSorted()]));
      for (const seeded of live) expect(stored.get(seeded.id)).toStrictEqual(product(seeded));
      expect(stored.get(revokedId)).toStrictEqual(product(REVOKED_SHAPE));
    });

    it('each migrated row allows exactly what it allowed, call by call', async () => {
      await db.app.withBusiness(business, async (tx) => {
        for (const seeded of live) {
          // oxlint-disable-next-line no-await-in-loop
          const delegation = await resolveLiveById(tx, seeded.agentActorId, seeded.id);
          expect(delegation).toBeDefined();
          if (delegation === undefined) continue;
          for (const collection of COLLECTIONS) {
            for (const action of ACTIONS) {
              // oxlint-disable-next-line no-await-in-loop
              const reach = await checkDelegatedAuthority(tx, delegation, {
                collection,
                action,
                scope: delegation.purposeScope,
              });
              const allowedBefore =
                action !== 'decide' &&
                seeded.collections.includes(collection) &&
                seeded.actions.includes(action);
              const code = reach.ok ? 'ok' : reach.refusal.code;
              expect([collection, action, code]).toStrictEqual([
                collection,
                action,
                allowedBefore
                  ? 'DELEGATION_NARROWED'
                  : action === 'decide'
                    ? 'DELEGATION_EXCLUDES_DECISION'
                    : 'DELEGATION_OUT_OF_PURPOSE',
              ]);
            }
          }
        }
      });
    });

    it('the product columns are gone', async () => {
      const columns = await db.admin.execute<{ readonly name: string }>(
        `select column_name as name from information_schema.columns
        where table_schema = 'public' and table_name = 'delegations'
          and column_name in ('collections', 'actions', 'pairs')`,
      );
      expect(columns.map((row) => row.name)).toStrictEqual(['pairs']);
    });
  },
);
