// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: the manual privacy runbook (`docs/local/PRIVACY-RUNBOOK.md`) and its dry
// run on made-up data. The page must name who owns each request, the response
// times, every request kind and every kind of copy, and when it stops being in
// force. The dry run plants a canary person (their person row, an identifier, a
// task naming them and an incident naming them), enumerates every copy with the
// runbook's own finder (`scripts/privacy/find-copies.mjs`, run as a process
// against this world's database), exports them, deletes each copy or records
// the lawful reason it is kept, then searches again: any hit outside a lawfully
// kept copy fails. The finder runs for one business only: a same-named person
// in another business never reaches its list or its export. The leg that
// searches a backup restored from before the erasure waits on S0-3's restore.
// The cases run in order and share the plant.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { bearer, call, personPath, serverUrl } from '../acceptance/world.ts';
import { findCopies, type Hit } from './c81-privacy-runbook-finder.ts';

const RUNBOOK = readFileSync(
  new URL('../../docs/local/PRIVACY-RUNBOOK.md', import.meta.url),
  'utf8',
);

// One word the search column keeps whole, so the index copy is found too.
const CANARY = `qx7canary${randomUUID().slice(0, 8)}`;
const NAME = `Casey ${CANARY}`;

if (serverUrl === undefined) {
  console.warn(
    'operations/c81-privacy-runbook: DATABASE_URL is unset, so the dry run did not run.',
  );
}

const test = it.skipIf(serverUrl === undefined);
let harness: Harness;
let adminUrl: string;
const plant = { personId: randomUUID(), incidentId: '', found: [] as readonly Hit[] };

beforeAll(async () => {
  if (serverUrl === undefined) return;
  harness = await createHarness('c81_runbook');
  const url = new URL(process.env['DATABASE_ADMIN_URL'] ?? serverUrl);
  url.pathname = `/${harness.world.db.name}`;
  adminUrl = url.toString();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** The finder as an operator runs it, for one business (alpha unless named). */
const find = (args: readonly string[], business: string | null = 'alpha') =>
  findCopies(adminUrl, args, business);

/** The canary person: their row, an identifier, a task and an incident naming them. */
async function plantCanaryPerson(): Promise<string> {
  const { world } = harness;
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, $3)`,
      [world.alpha, plant.personId, NAME],
    );
    await tx.query(
      `insert into public.person_identifiers
         (business_id, id, person_id, kind, value, observed_value, source_system)
       values ($1, $2, $3, 'email', $4, $4, 'dry-run')`,
      [world.alpha, randomUUID(), plant.personId, `${CANARY}@example.test`],
    );
  });
  const as = async (path: string, body: object) =>
    await call(
      world.api,
      personPath('alpha', path),
      { operationId: `c81p-${randomUUID()}`, ...body },
      bearer(world.ada.token),
    );
  const task = await as('/task/create', { fields: { title: `Call back ${NAME}` } });
  expect(task.status, 'the task naming them').toBe(200);
  const incident = await as('/privacy/record_incident', {
    whatHappened: 'A made-up folder link reached the wrong person.',
    foundAt: new Date().toISOString(),
    foundBy: 'The second operator',
    affected: NAME,
    informationKinds: ['contact'],
  });
  expect(incident.status, 'the incident naming them').toBe(200);
  return String((incident.body['detail'] as Record<string, unknown>)['incidentId']);
}

it('C81 manual privacy runbook: the page names the owner, the response times, every request and every kind of copy, and when it stops being in force', () => {
  expect(RUNBOOK).toMatch(/\*\*Owner of every request:\*\* the business owner/u);
  expect(RUNBOOK).toMatch(/\| Access +\| within 30 days of the request +\| APP 12 +\|/u);
  expect(RUNBOOK).toMatch(/\| Correction +\| within 30 days of the request +\| APP 13 +\|/u);
  for (const request of ['Access', 'Correction', 'Erasure', 'Export', 'Legal hold', 'Retention']) {
    expect(RUNBOOK, request).toContain(`### ${request}\n`);
  }
  for (const copy of [
    'Records',
    'Search indexes',
    'Exports',
    'Prompts',
    'Traces',
    'Files at outside services',
    'Backups',
  ]) {
    expect(RUNBOOK, copy).toContain(`- **${copy}:**`);
  }
  expect(RUNBOOK).toMatch(
    /privacy-request workflows \(C61-R\), the\s+scheduled retention purge \(C62\), and the copy register's erasure fan-out\s+\(C84\)/u,
  );
  expect(RUNBOOK).toContain('node scripts/privacy/find-copies.mjs');
});

test('C81 manual privacy runbook: dry run: a planted canary person is found in every copy, the search column included, and never in the evidence tables', async () => {
  plant.incidentId = await plantCanaryPerson();
  const found = await find(['--text', CANARY]);
  expect(found.code).toBe(0);
  const tables = new Set(found.hits.map((hit) => hit.table));
  for (const table of ['people', 'person_identifiers', 'records', 'privacy_incidents']) {
    expect(tables, table).toContain(table);
  }
  expect(found.hits.find((hit) => hit.table === 'records')?.columns).toContain('search_tsv');
  expect(tables).not.toContain('audit_events');
  expect(tables).not.toContain('operations');
  // The list alone carries no row.
  expect(found.hits.every((hit) => hit.row === undefined)).toBe(true);
  plant.found = found.hits;
});

test('C81 manual privacy runbook: dry run: the export holds every copy found, in any letter case', async () => {
  const exported = await find(['--text', CANARY.toUpperCase(), '--export']);
  // The person row, the identifier, the task and the incident at least.
  expect(exported.hits.length).toBeGreaterThanOrEqual(4);
  expect(exported.hits.map((hit) => [hit.table, hit.id])).toEqual(
    plant.found.map((hit) => [hit.table, hit.id]),
  );
  for (const hit of exported.hits) {
    expect(JSON.stringify(hit.row).toLowerCase(), hit.table).toContain(CANARY);
  }
});

test('C81 manual privacy runbook: dry run: each copy is deleted or kept for a lawful reason, and a search finds nothing outside the kept copy', async () => {
  // The incident is a breach record under assessment, kept by the owner's decision.
  const kept = new Set([`privacy_incidents:${plant.incidentId}`]);
  const outside = (hits: readonly Hit[]) =>
    hits.filter((hit) => !kept.has(`${hit.table}:${hit.id}`));
  expect(outside(plant.found).length, 'before the erasure').toBeGreaterThan(0);
  const recordIds = plant.found.filter((hit) => hit.table === 'records').map((hit) => hit.id);
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    await tx.query(`delete from public.person_identifiers where person_id = $1`, [plant.personId]);
    await tx.query(`delete from public.people where id = $1`, [plant.personId]);
    // The record step as the runbook gives it: its unique values and links,
    // then the record.
    for (const step of [
      `delete from public.record_unique_values where record_id = any($1::uuid[])`,
      `delete from public.record_links
        where from_record_id = any($1::uuid[]) or to_record_id = any($1::uuid[])`,
      `delete from public.records where id = any($1::uuid[])`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      await tx.query(step, [recordIds]);
    }
  });
  const after = await find(['--text', CANARY]);
  expect(after.code).toBe(0);
  expect(outside(after.hits)).toEqual([]);
  expect(after.hits.map((hit) => hit.table)).toEqual(['privacy_incidents']);
});

test('C81 manual privacy runbook: the finder matches the text alone, in any letter case, as the row holds it, and refuses a text too short to name anyone', async () => {
  const quoted = `O"Brien\\${CANARY}x`;
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, $3)`,
      [harness.world.alpha, randomUUID(), quoted],
    );
  });
  const tablesFor = async (text: string) =>
    (await find(['--text', text])).hits.map((hit) => hit.table);
  expect(await tablesFor(quoted.toLowerCase())).toEqual(['people']);
  // A pattern character is the character, never a wildcard.
  expect(await tablesFor(`o"brien\\${CANARY.slice(0, 5)}%`)).toEqual([]);
  expect(await tablesFor(`o"brien\\${CANARY.slice(0, 5)}_anary`)).toEqual([]);
  for (const args of [['--text', 'ab'], ['--text'], [], ['--txt', CANARY]]) {
    // oxlint-disable-next-line no-await-in-loop
    const refused = await find(args);
    expect({ code: refused.code, hits: refused.hits }, args.join(' ')).toEqual({
      code: 2,
      hits: [],
    });
  }
});

test('find-copies refuses to run without a business', async () => {
  for (const args of [
    ['--text', CANARY],
    ['--text', CANARY, '--export'],
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    const refused = await find(args, null);
    expect({ code: refused.code, stdout: refused.stdout }, args.join(' ')).toEqual({
      code: 2,
      stdout: '',
    });
    expect(refused.stderr).toContain('--business');
  }
  const unknown = await find(['--text', CANARY], `nobody-${CANARY}`);
  expect({ code: unknown.code, stdout: unknown.stdout }).toEqual({ code: 2, stdout: '' });
});

test('find-copies finds nothing in another business', async () => {
  const { world } = harness;
  // The same person's name in alpha and in bravo; bravo's copy carries a
  // canary that alpha's list and export must never hold.
  const twin = `qx7twin${randomUUID().slice(0, 8)}`;
  const bravoCanary = `qx7bravo${randomUUID().slice(0, 8)}`;
  const ids = { alpha: randomUUID(), bravo: randomUUID() };
  for (const key of ['alpha', 'bravo'] as const) {
    const businessId = world[key];
    // oxlint-disable-next-line no-await-in-loop
    await world.db.app.withBusiness(businessId, async (tx) => {
      await tx.query(
        `insert into public.people (business_id, id, display_name) values ($1, $2, $3)`,
        [businessId, ids[key], `Jordan ${twin}`],
      );
      await tx.query(
        `insert into public.person_identifiers
           (business_id, id, person_id, kind, value, observed_value, source_system)
         values ($1, $2, $3, 'email', $4, $4, 'dry-run')`,
        [
          businessId,
          randomUUID(),
          ids[key],
          key === 'bravo' ? `${twin}.${bravoCanary}@example.test` : `${twin}@example.test`,
        ],
      );
    });
  }
  const inAlpha = await find(['--text', twin, '--export'], 'alpha');
  expect(inAlpha.code).toBe(0);
  expect(inAlpha.hits.map((hit) => hit.table)).toEqual(['people', 'person_identifiers']);
  expect(inAlpha.hits.map((hit) => hit.row?.['business_id'])).toEqual([world.alpha, world.alpha]);
  expect(inAlpha.stdout).not.toContain(bravoCanary);
  expect(inAlpha.stdout).not.toContain(ids.bravo);
  expect(inAlpha.stdout).not.toContain(world.bravo);
  // Bravo's own run finds bravo's copies, canary included, and none of alpha's.
  const inBravo = await find(['--text', twin, '--export'], 'bravo');
  expect(inBravo.hits.map((hit) => hit.row?.['business_id'])).toEqual([world.bravo, world.bravo]);
  expect(inBravo.stdout).toContain(bravoCanary);
  expect(inBravo.stdout).not.toContain(ids.alpha);
});

test('find-copies finds the person by name in every kind of copy the runbook lists, memberships included', async () => {
  const { world } = harness;
  const member = `qx7member${randomUUID().slice(0, 8)}`;
  const personId = randomUUID();
  const membershipId = randomUUID();
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, $3)`,
      [world.alpha, personId, `Riley ${member}`],
    );
    await tx.query(
      `insert into public.memberships (business_id, id, person_id, role_key) values ($1, $2, $3, 'staff')`,
      [world.alpha, membershipId, personId],
    );
  });
  // The runbook's Records copy names memberships; a reply that misses the
  // person's membership misses a copy of them.
  const found = await find(['--text', member]);
  expect(found.code).toBe(0);
  expect(found.hits.map((hit) => [hit.table, hit.id])).toContainEqual([
    'memberships',
    membershipId,
  ]);
});
