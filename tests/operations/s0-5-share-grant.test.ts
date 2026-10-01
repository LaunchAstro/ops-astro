// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5 and MP-4-10: the task share grant (`task.share_with_client`) under the
// gate before the first real client data. A share gives the task's
// visibility to the client's existing people and enrols or invites no one,
// so S0-5 classes it `client-data`, not `invitation` (CS-4.10, TR-S-PIR5-2);
// and with any gate item open on a real-data installation it is refused in
// plain words and writes nothing (TR-SECPIR4-2). Run in S0-5's suite, through
// the real API on a throwaway database.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_EFFECTS,
  COMMAND_SURFACE,
  classOf,
  type CommandDeclaration,
} from '../../packages/core-wire/src/index.ts';
import { GATE_ITEMS } from '../../packages/core-commands/src/index.ts';
import { gateRecordBody } from '../acceptance/role-case-gate-bodies.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';

if (serverUrl === undefined) {
  console.warn('operations/s0-5-share-grant: DATABASE_URL is unset, so nothing below ran.');
}

const SHARE = COMMAND_SURFACE.find(
  (declaration) => declaration.name === 'task.share_with_client',
) as CommandDeclaration;

/** Written for every call as the record of the act, never a record kind of its own. */
const BOOKKEEPING: ReadonlySet<string> = new Set([
  'audit_events',
  'operations',
  'authentication_attempts',
]);

/** Where a person, a login or an invitation would be made. */
const ENROLMENT = /person|people|login|invit|actor|member|session|credential/u;

let harness: Harness;

const admin = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await harness.world.db.admin.execute<T & Record<string, unknown>>(sql, params)) as T[];

async function tickAll(): Promise<void> {
  for (const item of GATE_ITEMS) {
    const { evidence, statement } = gateRecordBody(item);
    // eslint-disable-next-line no-await-in-loop -- one item at a time
    await admin(
      `insert into ops.gate_items (item, evidence, statement) values ($1, $2, $3)
        on conflict (item) do nothing`,
      [item, evidence, statement ?? null],
    );
  }
}

/** Each public table's rows as one digest, read past row security on the owner's connection. */
async function fingerprint(): Promise<ReadonlyMap<string, string>> {
  const tables = await admin<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
  );
  const union = tables
    .map(
      ({ name }) =>
        `select '${name}' as name, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from public.${name} t`,
    )
    .join(' union all ');
  const rows = await admin<{ name: string; digest: string }>(union);
  return new Map(rows.map((row) => [row.name, row.digest]));
}

const changed = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>) =>
  [...after.keys()].filter(
    (table) => !BOOKKEEPING.has(table) && after.get(table) !== before.get(table),
  );

/** A task on a fresh client with the client's existing person standing on it. */
async function shareBody(): Promise<Record<string, unknown>> {
  const prepared = await harness.positiveBody(SHARE);
  if ('exception' in prepared) throw new Error(`share: ${prepared.exception}`);
  return { ...prepared.body };
}

describe('S0-5 share grant enrols no one: the class', () => {
  it('S0-5 share grant enrols no one: S0-5 classes the share grant client-data, never an invitation', () => {
    const effects = COMMAND_EFFECTS['task.share_with_client'];
    expect(effects.access).toBe(false);
    expect(classOf(effects)).toBe('client-data');
    // Taking a share back gives no one anything, so the gate never holds it up.
    expect(classOf(COMMAND_EFFECTS['task.revoke_client_share'])).toBe('made-up-safe');
  });
});

describe.skipIf(serverUrl === undefined)('S0-5 the task share grant under the gate', () => {
  beforeAll(async () => {
    harness = await createHarness('s05share');
  }, 300_000);

  afterAll(async () => {
    await harness?.close();
  });

  it("S0-5 share grant enrols no one: a share grant lets the client's existing people see the task and creates no invitation, login or person", async () => {
    const body = await shareBody();
    const before = await fingerprint();
    const shared = await harness.asPerson('task.share_with_client', body);
    expect(shared.code, JSON.stringify(shared.body)).toBe('ok');
    const wrote = changed(before, await fingerprint());
    expect(wrote).toContain('grants');
    expect(wrote.filter((table) => ENROLMENT.test(table))).toStrictEqual([]);
  });

  it('MP-4-10 gate refusal: with the gate forced open, the share grant is refused in plain words and writes nothing', async () => {
    await tickAll();
    await admin(`update ops.installation set mode = 'real'`);
    // Made while the gate is closed: the task's client is itself client data.
    const body = await shareBody();
    await admin(`delete from ops.gate_items where item = 'legal-basics'`);
    const before = await fingerprint();
    const refused = await harness.asPerson('task.share_with_client', body);
    expect([refused.status, refused.code]).toStrictEqual([409, 'GATE_SHUT']);
    expect(refused.body['names']).toStrictEqual(['legal-basics']);
    const fixes = refused.body['fixes'];
    expect(Array.isArray(fixes) && fixes.length > 0).toBe(true);
    expect((fixes as unknown[]).every((fix) => typeof fix === 'string')).toBe(true);
    expect(changed(before, await fingerprint())).toStrictEqual([]);

    // The control: every item done, the same share runs on the real installation.
    await tickAll();
    const shared = await harness.asPerson('task.share_with_client', body);
    expect(shared.code, JSON.stringify(shared.body)).toBe('ok');
  });
});
