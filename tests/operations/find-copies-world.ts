// SPDX-License-Identifier: AGPL-3.0-only
//
// A throwaway database with two businesses for the copy finder's suites
// (scripts/privacy/find-copies.mjs), and the plants they share.

import { randomUUID } from 'node:crypto';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import type { Hit } from './c81-privacy-runbook-finder.ts';

export interface FinderWorld {
  readonly db: FreshDatabase;
  readonly adminUrl: string;
  readonly alpha: string;
  readonly bravo: string;
}

export async function openFinderWorld(part: string): Promise<FinderWorld> {
  const serverUrl = databaseUrlFromEnvironment();
  if (serverUrl === undefined) throw new Error('The finder cases need a throwaway Postgres server');
  const db = await createFreshDatabase({ part, serverUrl });
  const url = new URL(serverUrl);
  url.pathname = `/${db.name}`;
  const world = { db, adminUrl: url.toString(), alpha: randomUUID(), bravo: randomUUID() };
  await db.admin.execute(
    `insert into public.businesses (business_id, id, key, name)
     values ($1, $1, 'alpha', 'alpha'), ($2, $2, 'bravo', 'bravo')`,
    [world.alpha, world.bravo],
  );
  return world;
}

/** A word no other case plants, so each case's text names its own people only. */
export const word = (stem: string): string => `${stem}${randomUUID().slice(0, 8)}`;

export interface PlantedPerson {
  readonly id: string;
  readonly actor: string;
  readonly membership: string;
}

/** A person with an acting identity and a membership; answers the ids. */
export async function plantPerson(
  world: FinderWorld,
  business: string,
  name: string,
): Promise<PlantedPerson> {
  const ids = { id: randomUUID(), actor: randomUUID(), membership: randomUUID() };
  await world.db.admin.execute(
    'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
    [business, ids.id, name],
  );
  await world.db.admin.execute(
    "insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)",
    [business, ids.actor, ids.id],
  );
  await world.db.admin.execute(
    "insert into public.memberships (business_id, id, person_id, role_key) values ($1, $2, $3, 'staff')",
    [business, ids.membership, ids.id],
  );
  return ids;
}

/** An email identifier of a person in alpha; answers its id. */
export async function plantIdentifier(
  world: FinderWorld,
  personId: string,
  value: string,
  reviewState: string,
): Promise<string> {
  const id = randomUUID();
  await world.db.admin.execute(
    `insert into public.person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
     values ($1, $2, $3, 'email', $4, $4, 'dry-run', $5)`,
    [world.alpha, id, personId, value, reviewState],
  );
  return id;
}

export const pairs = (hits: readonly Hit[]): readonly (readonly [string, string])[] =>
  hits.map((hit) => [hit.table, hit.id] as const);

export const hitOn = (hits: readonly Hit[], table: string, id: string): Hit | undefined =>
  hits.find((hit) => hit.table === table && hit.id === id);
