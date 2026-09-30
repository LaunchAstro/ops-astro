// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the readiness check, through the real API on a throwaway database.
//
// The installation's mode and the eight gate items live in `ops`, which no
// person or agent can reach; the command envelope reads them through one
// function inside the refused command's own transaction. A made-up-data
// installation (this harness, staging) runs every command. A real-data
// installation refuses every command the catalogue classes `client-data` or
// `invitation` while any item is open, and writes nothing.
//
// The cases run in order on one database: the mode only ever moves one way,
// so once it is real it stays real. Every command's body is prepared first,
// while the installation is still made-up, because the fixtures themselves
// create tasks and clients.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_EFFECTS,
  COMMAND_SURFACE,
  classOf,
  type CommandDeclaration,
} from '../../packages/core-wire/src/index.ts';
import { GATE_ITEMS } from '../../packages/core-commands/src/index.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';

if (serverUrl === undefined) {
  console.warn('operations/s0-5-readiness: DATABASE_URL is unset, so nothing below ran.');
}

/** Written for every call as the record of the act, never a record kind of its own. */
const BOOKKEEPING: ReadonlySet<string> = new Set([
  'audit_events',
  'operations',
  'authentication_attempts',
]);

const GATED = COMMAND_SURFACE.filter(
  (declaration) => classOf(COMMAND_EFFECTS[declaration.name]) !== 'made-up-safe',
);

let harness: Harness;
const bodies = new Map<string, Record<string, unknown>>();
let agentPickup: Record<string, unknown>;

const admin = async <T>(sql: string): Promise<T[]> =>
  (await harness.world.db.admin.execute<T & Record<string, unknown>>(sql)) as T[];

async function readiness(): Promise<{ mode: string; open_items: string[] }> {
  const [row] = await admin<{ mode: string; open_items: string[] }>(
    'select mode, open_items from public.first_client_readiness()',
  );
  return row!;
}

async function tickAll(): Promise<void> {
  const items = GATE_ITEMS.map((item) => `('${item}', 'https://evidence.example/${item}')`);
  await admin(`insert into ops.gate_items (item, evidence) values ${items.join(', ')}
    on conflict (item) do nothing`);
}

async function forceOpen(item: string): Promise<void> {
  await tickAll();
  await admin(`delete from ops.gate_items where item = '${item}'`);
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

function changed(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...after.keys()].filter(
    (table) => !BOOKKEEPING.has(table) && after.get(table) !== before.get(table),
  );
}

/** What each gated command was answered, where it was not a plain-words GATE_SHUT naming `open`. */
async function notShut(
  declarations: readonly CommandDeclaration[],
  open: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const { name } of declarations) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await harness.asPerson(name, bodies.get(name)!);
    const fixes = answer.body['fixes'];
    const plain =
      Array.isArray(fixes) && fixes.length > 0 && fixes.every((fix) => typeof fix === 'string');
    if (answer.code !== 'GATE_SHUT' || answer.status !== 409 || !plain) {
      found.push(`${name}: ${answer.status} ${answer.code}`);
    } else if (JSON.stringify(answer.body['names']) !== JSON.stringify([open])) {
      found.push(`${name}: names ${JSON.stringify(answer.body['names'])}`);
    }
  }
  return found;
}

/** The positive recipe, or, for a live delegation (the recipe has none), one made here. */
async function bodyFor(declaration: CommandDeclaration): Promise<Record<string, unknown>> {
  if (declaration.name === 'delegation.revoke') {
    const task = await harness.freshTask(`s0-5 gate ${randomUUID()}`);
    const decided = await harness.reserve(task, 'draft_the_gate_reply');
    const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
    const picked = await harness.asAgent('task.pickup', { reservationId });
    return { delegationId: (picked.body['detail'] as Record<string, unknown>)['delegationId'] };
  }
  const prepared = await harness.positiveBody(declaration);
  if ('exception' in prepared) throw new Error(`${declaration.name}: ${prepared.exception}`);
  return { ...prepared.body };
}

/** made-up to real only while every item is done; never back; the app's role reaches neither table. */
async function modeOneWay(): Promise<void> {
  const toReal = `update ops.installation set mode = 'real'`;
  await expect(admin(toReal)).rejects.toThrow(/INSTALLATION_NOT_READY/u);
  await forceOpen('security-pass');
  await expect(admin(toReal)).rejects.toThrow(/INSTALLATION_NOT_READY/u);
  await tickAll();
  await admin(toReal);
  expect(await readiness()).toStrictEqual({ mode: 'real', open_items: [] });
  const oneWay = /INSTALLATION_MODE_ONE_WAY/u;
  await expect(admin(`update ops.installation set mode = 'made-up'`)).rejects.toThrow(oneWay);
  await expect(admin('delete from ops.installation')).rejects.toThrow(oneWay);
  await expect(admin(`insert into ops.installation (mode) values ('made-up')`)).rejects.toThrow();
  const reach = [
    'select mode from ops.installation',
    `update ops.installation set mode = 'made-up'`,
    'select item from ops.gate_items',
    'delete from ops.gate_items',
  ].map((sql) =>
    harness.world.db.app
      .withBusiness(harness.world.alpha, async (tx) => await tx.query(sql))
      .then(
        () => `${sql}: allowed`,
        (error: unknown) => (/permission denied/u.test(String(error)) ? '' : `${sql}: ${error}`),
      ),
  );
  expect((await Promise.all(reach)).filter(Boolean)).toStrictEqual([]);
  expect(await readiness()).toStrictEqual({ mode: 'real', open_items: [] });
}

/** Each item forced open in turn: every gated command shut, naming it, and nothing written. */
async function eachItemShuts(): Promise<string[]> {
  const found: string[] = [];
  for (const item of GATE_ITEMS) {
    // eslint-disable-next-line no-await-in-loop
    await forceOpen(item);
    // eslint-disable-next-line no-await-in-loop
    const before = await fingerprint();
    // eslint-disable-next-line no-await-in-loop
    const answered = await notShut(GATED, item);
    // eslint-disable-next-line no-await-in-loop
    const wrote = changed(before, await fingerprint());
    found.push(
      ...answered.map((line) => `${item}: ${line}`),
      ...wrote.map((table) => `${item}: wrote ${table}`),
    );
  }
  await tickAll();
  return found;
}

/** One item open: each gated command alone, its own digest before and after. */
async function eachCommandShut(open: string): Promise<string[]> {
  await forceOpen(open);
  const found: string[] = [];
  for (const declaration of GATED) {
    // eslint-disable-next-line no-await-in-loop
    const before = await fingerprint();
    // eslint-disable-next-line no-await-in-loop
    const answered = await notShut([declaration], open);
    // eslint-disable-next-line no-await-in-loop
    const wrote = changed(before, await fingerprint());
    found.push(...answered, ...wrote.map((table) => `${declaration.name}: wrote ${table}`));
  }
  await tickAll();
  return found;
}

/** The agent route reads the same check: its pickup refused, nothing written. */
async function agentRouteShut(open: string): Promise<unknown[]> {
  await forceOpen(open);
  const before = await fingerprint();
  const picked = await harness.asAgent('task.pickup', agentPickup);
  expect(changed(before, await fingerprint())).toStrictEqual([]);
  await tickAll();
  return [picked.status, picked.code, picked.body['names']];
}

describe.skipIf(serverUrl === undefined)('S0-5 readiness check', () => {
  beforeAll(async () => {
    harness = await createHarness('s05_gate');
    for (const declaration of GATED) {
      // eslint-disable-next-line no-await-in-loop
      bodies.set(declaration.name, await bodyFor(declaration));
    }
    const decided = await harness.reserve(await harness.freshTask('s0-5 agent'), 'draft_the_reply');
    agentPickup = {
      reservationId: (decided.body['detail'] as Record<string, unknown>)['reservationId'],
    };
  }, 300_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('S0-5 readiness: an installation starts made-up with every item open, and runs client-data commands', async () => {
    expect(GATED.length).toBeGreaterThan(0);
    expect(await readiness()).toStrictEqual({ mode: 'made-up', open_items: GATE_ITEMS.toSorted() });
    const task = await harness.freshTask('s0-5 made-up runs');
    expect(task.revision).toBeGreaterThan(0);
  });

  it('S0-5 mode one way: made-up to real only while the readiness check is true, never back, and no one else writes it', async () => {
    await modeOneWay();
  });

  it('S0-5 gate refusals: with each of the eight items forced open in turn, every client-data and invitation command is refused in plain words and writes nothing', async () => {
    expect((await readiness()).mode).toBe('real');
    expect(await eachItemShuts()).toStrictEqual([]);
    // A made-up-safe command still runs while an item is open.
    await forceOpen('legal-basics');
    expect((await harness.asPerson('access.read', {})).code).toBe('ok');
    await tickAll();
  }, 600_000);

  it('S0-5 gate coverage (gate forced open): every client-data and invitation command in the catalogue is refused and writes nothing', async () => {
    expect(await eachCommandShut('phone-alerts')).toStrictEqual([]);
    expect(await agentRouteShut('second-factor')).toStrictEqual([
      409,
      'GATE_SHUT',
      ['second-factor'],
    ]);
    // Every item done: the same commands run on a real-data installation.
    const task = await harness.freshTask('s0-5 real, gate closed');
    expect(task.revision).toBeGreaterThan(0);
  }, 600_000);
});
