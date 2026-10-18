// SPDX-License-Identifier: AGPL-3.0-only
//
// The own-site binding step's world (scripts/ops/bind-own-site.ts): a fresh
// local database with two businesses, the agency and another, their people
// signed in through the test key set on loopback, and a record folder of its
// own. `ownSiteHooks()` makes it in the calling file and drops it after.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { RECORD_FILE } from '../../scripts/ops/deployment-record.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { serveTestKeySet, signBearer, TEST_ISSUER, type ServedKeySet } from '../support/sign-in.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

/** Each person's sign-in subject. */
export const subjects = {
  operator: `op-${randomUUID()}`,
  keyless: `kl-${randomUUID()}`,
  otherOperator: `oo-${randomUUID()}`,
};

export interface OwnSiteWorld {
  readonly db: FreshDatabase;
  readonly agency: string;
  readonly other: string;
  /** The agency operator's actor, which the binding names as its writer. */
  readonly operatorActor: string;
  readonly records: string;
  readonly adminUrl: string;
}

/** A person with a login, a membership and an `operations` grant over the whole business. */
async function person(
  tx: TenantQuery,
  subject: string,
  action: 'manage' | 'read',
): Promise<string> {
  const id = await insertPerson(tx, subject.slice(0, 2));
  const actor = await insertActor(tx, id);
  await insertMembership(tx, id);
  await insertMapping(tx, await insertLogin(tx, subject), id, actor);
  const issued = await issueGrant(tx, [{ kind: 'actor', id: actor }], {
    subject: { kind: 'person', id },
    scope: { kind: 'business', id: null },
    collection: 'operations',
    action,
    parentGrantId: null,
    grantedByActorId: actor,
  });
  expect(issued.ok).toBe(true);
  return actor;
}

let keySet: ServedKeySet | undefined;

/** The world, made in the calling file's `beforeAll` and handed to `share`; none without a server. */
export function ownSiteHooks(share: (world: OwnSiteWorld) => void): void {
  let world: OwnSiteWorld | undefined;
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    keySet = await serveTestKeySet();
    const db = await createFreshDatabase({ part: 'ownsite' });
    const agency = await insertBusiness(db.app, 'agency');
    const other = await insertBusiness(db.app, 'other');
    let operatorActor = '';
    await db.app.withBusiness(agency, async (tx) => {
      operatorActor = await person(tx, subjects.operator, 'manage');
      await person(tx, subjects.keyless, 'read');
    });
    await db.app.withBusiness(other, async (tx) => {
      await person(tx, subjects.otherOperator, 'manage');
    });
    const adminUrl = new URL(serverUrl as string);
    adminUrl.pathname = `/${db.name}`;
    const records = mkdtempSync(join(tmpdir(), 'own-site-records-'));
    world = { db, agency, other, operatorActor, records, adminUrl: adminUrl.toString() };
    share(world);
  }, 60_000);
  afterAll(async () => {
    await keySet?.close();
    await world?.db.drop();
    if (world !== undefined) rmSync(world.records, { recursive: true, force: true });
  });
}

/** The step's environment: `subject` signed in to the business keyed `business`. */
export async function signedIn(
  world: OwnSiteWorld,
  subject: string,
  business: 'agency' | 'other',
  own: Readonly<Record<string, string>> = {},
): Promise<Record<string, string>> {
  const token = await signBearer({
    sub: subject,
    aud: 'authenticated',
    iss: TEST_ISSUER,
    role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  return {
    OPS_ASTRO_TOKEN: token,
    OPS_ASTRO_BUSINESS: business,
    OPS_ASTRO_DEPLOYMENTS: world.records,
    DATABASE_URL: world.db.appUrl,
    DATABASE_ADMIN_URL: world.adminUrl,
    SUPABASE_KEY_SET_URL: keySet?.url ?? '',
    GOTRUE_URL: TEST_ISSUER,
    ...own,
  };
}

/** Every own site and page in the installation, whole rows, as the owner reads them. */
export async function allSites(world: OwnSiteWorld): Promise<{
  sites: readonly Record<string, unknown>[];
  pages: readonly Record<string, unknown>[];
}> {
  const sites = await world.db.admin.execute<Record<string, unknown>>(
    `select to_jsonb(s) as row from public.party_sites s order by business_id, holder`,
  );
  const pages = await world.db.admin.execute<Record<string, unknown>>(
    `select to_jsonb(p) as row from public.party_site_pages p order by business_id, page_url`,
  );
  return { sites, pages };
}

/** The business's own site row and pages, as the owner reads them. */
export async function ownSiteOf(
  world: OwnSiteWorld,
  businessId: string,
): Promise<{
  site: Record<string, unknown> | undefined;
  pages: readonly { readonly page_url: string; readonly path: string }[];
}> {
  const [site] = await world.db.admin.execute<Record<string, unknown>>(
    `select party_id, repository, default_branch, project, changed_by_actor_id::text, revision
       from public.party_sites where business_id = $1 and party_id is null`,
    [businessId],
  );
  const pages = await world.db.admin.execute<{ page_url: string; path: string }>(
    `select page_url, path from public.party_site_pages
      where business_id = $1 and party_id is null order by page_url`,
    [businessId],
  );
  return { site, pages };
}

/** The deployment records written so far, one object per line. */
export function recordsIn(world: OwnSiteWorld): readonly Record<string, unknown>[] {
  let text = '';
  try {
    text = readFileSync(join(world.records, RECORD_FILE), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The revision a run's lines print, or undefined. */
export const printedRevision = (lines: readonly string[]): number | undefined => {
  const found = /stored revision (\d+)/u.exec(lines.join('\n'));
  return found === null ? undefined : Number(found[1]);
};
