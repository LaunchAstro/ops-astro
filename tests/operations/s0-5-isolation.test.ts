// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5 isolation: the first-client gate, crossed three ways through the real
// API on a throwaway database. The gate's tables are installation-wide: they
// hold no business, client or person, so each crossing is about what the gate
// answers, not rows it holds. Another business is shut by the same open items
// and learns their names alone; another client, and another task under a live
// delegation, are answered by authority first, exactly as a made-up id is, and
// never by the gate. A canary sits in the gate's evidence and owner's line and
// in client B's task, and reaches no body, refusals included, and no audit
// row. The installation is real with one item open; the cases share it.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATE_ITEMS } from '../../packages/core-commands/src/index.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { gateRecordBody } from '../acceptance/role-case-gate-bodies.ts';
import { agentPath, bearer, call, serverUrl, tokenFor, type Answer } from '../acceptance/world.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { admin, openGateWorld, RECORD, send, type GateWorld } from './s0-5-gate-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/s0-5-isolation: DATABASE_URL is unset, so nothing below ran.');
}

const CANARY = `s05iso${randomUUID().slice(0, 8)}`;
const OPEN = ['phone-alerts'];
const COMMENT = '/task/comment';

let gate: GateWorld;
const tasks = { a: '', b: '', delegated: '' };
let cleo = '';

type Send = (recordId: string) => Promise<Answer>;
type Expected = readonly [status: number, code: string];

const revision = async (id: string): Promise<number> =>
  Number(
    (
      await admin<{ r: string }>(gate, 'select revision::text as r from records where id = $1', [
        id,
      ])
    )[0]?.r ?? 1,
  );

const comment = async (id: string) => ({
  recordId: id,
  expectedRevision: await revision(id),
  body: `a note ${CANARY}`,
  audience: 'internal',
});

/** The records and both gate tables, as one digest: a refusal must leave it. */
async function digest(): Promise<string> {
  const [row] = await admin<{ d: string }>(
    gate,
    `select md5(
       (select coalesce(string_agg(t::text, '|' order by t::text), '') from public.records t) ||
       (select coalesce(string_agg(t::text, '|' order by t::text), '') from ops.installation t) ||
       (select coalesce(string_agg(t::text, '|' order by t::text), '') from ops.gate_items t)) as d`,
  );
  return row!.d;
}

const seen = (answer: Answer, id: string): string =>
  JSON.stringify({ status: answer.status, body: answer.body }).replaceAll(id, '<id>');

/**
 * A crossing: `send` at the foreign task answers `expected`, byte for byte as
 * at a made-up id, carries no canary, and writes nothing. What was wrong.
 */
async function crossing(label: string, to: Send, foreign: string, expected: Expected) {
  const made = randomUUID();
  const before = await digest();
  const [there, madeUp] = [await to(foreign), await to(made)];
  const wrong: string[] = [];
  if (there.status !== expected[0] || there.code !== expected[1]) {
    wrong.push(`${label}: ${String(there.status)} ${there.code}`);
  }
  if (seen(there, foreign) !== seen(madeUp, made)) wrong.push(`${label}: unlike a made-up id`);
  if (there.text.includes(CANARY) || there.text.includes(foreign)) wrong.push(`${label}: leaked`);
  if ((await digest()) !== before) wrong.push(`${label}: wrote`);
  return wrong;
}

/** Shut by the gate: 409 GATE_SHUT naming the open item alone, no canary. */
const shut = (answer: Answer) => [
  answer.status,
  answer.code,
  answer.body['names'],
  answer.text.includes(CANARY),
];

async function asCleo(recordId: string): Promise<Answer> {
  return await send(gate, COMMENT, await comment(recordId), cleo);
}

async function asAgent(recordId: string): Promise<Answer> {
  const { world } = gate.harness;
  return await call(
    world.api,
    agentPath('alpha', COMMENT),
    { operationId: randomUUID(), ...(await comment(recordId)) },
    { ...bearer(world.agent.token), [DELEGATION_HEADER]: gate.credential },
  );
}

/** A task on a client of its own, made while the installation is made-up. */
async function taskOnClient(key: string, title: string): Promise<string> {
  const { harness } = gate;
  const client = await harness.asPerson('client.create', { name: `${key} ${CANARY}` });
  const task = await harness.freshTask(title);
  const clientId = (client.body['detail'] as Record<string, unknown>)['clientId'];
  const set = await harness.asPerson('task.set_party', {
    recordId: task.id,
    expectedRevision: task.revision,
    fields: { client: clientId },
  });
  expect(set.code, key).toBe('ok');
  return task.id;
}

/** The canary in two records by the operator, every other item done, real, one item reopened. */
async function shutTheGate(): Promise<void> {
  const lines = [
    { item: 'tested-backups', evidence: `https://evidence.example/${CANARY}` },
    { ...gateRecordBody('training-line'), statement: `Training off, 2026-09-28, ${CANARY}.` },
  ];
  const answers = await Promise.all(lines.map(async (body) => await send(gate, RECORD, body)));
  expect(answers.map((answer) => answer.code)).toStrictEqual(['ok', 'ok']);
  const rest = GATE_ITEMS.map((item) => gateRecordBody(item));
  await admin(
    gate,
    `insert into ops.gate_items (item, evidence, statement)
     select * from unnest($1::text[], $2::text[], $3::text[]) on conflict (item) do nothing`,
    [
      rest.map((r) => r['item']),
      rest.map((r) => r['evidence']),
      rest.map((r) => r['statement'] ?? null),
    ],
  );
  await admin(gate, `update ops.installation set mode = 'real'`);
  await admin(gate, `delete from ops.gate_items where item = $1`, OPEN);
}

/** Made-up, then: two clients' tasks, Cleo's one grant on client A's; then the gate shut. */
async function prepare(): Promise<void> {
  gate = await openGateWorld();
  const { world } = gate.harness;
  [tasks.a, tasks.b] = await Promise.all([
    taskOnClient('a', 'client A task'),
    taskOnClient('b', `${CANARY} client B task`),
  ]);
  const [delegation] = await admin<{ id: string }>(
    gate,
    `select purpose_scope_id::text as id from delegations where revoked_at is null`,
  );
  tasks.delegated = delegation!.id;
  const member = await enrol(world.db.app, world.alpha, 'cleo');
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await grantTo(tx, member, 'comment', { kind: 'record', id: tasks.a });
  });
  cleo = await tokenFor(member.presented.subject);
  await shutTheGate();
}

/** Bravo: shut by alpha's open item, alike; alpha's task answered as made-up; the gate unmoved. */
async function anotherBusiness(): Promise<string[]> {
  const { world, bravoRecordId } = gate.harness;
  const bea = world.bea.token;
  const inBravo = await send(gate, COMMENT, await comment(bravoRecordId), bea, 'bravo');
  const inAlpha = await send(gate, COMMENT, await comment(tasks.a));
  expect(shut(inBravo)).toStrictEqual([409, 'GATE_SHUT', OPEN, false]);
  expect(inBravo.body['fixes']).toStrictEqual(inAlpha.body['fixes']);
  const inOwn: Send = async (id) => await send(gate, COMMENT, await comment(id), bea, 'bravo');
  const onAlpha: Send = async (id) => await send(gate, COMMENT, await comment(id), bea, 'alpha');
  const tick: Send = async (id) =>
    await send(gate, RECORD, { item: OPEN[0], evidence: `https://e.example/${id}` }, bea, 'bravo');
  return [
    ...(await crossing('bea names it in bravo', inOwn, tasks.b, [404, 'NOT_FOUND'])),
    ...(await crossing('bea on alpha', onAlpha, tasks.b, [403, 'AUTH_NO_MEMBERSHIP'])),
    ...(await crossing('bea ticks the open item', tick, CANARY, [403, 'SCOPE_NOT_GRANTED'])),
  ];
}

/** Each business's audit events and operation register, as text read by the app in it. */
async function auditOf(business: string): Promise<string> {
  const rows = await gate.harness.world.db.app.withBusiness(
    business,
    async (tx) =>
      await tx.query<{ row: string }>(
        `select to_jsonb(e)::text as row from public.audit_events e
         union all select to_jsonb(o)::text from public.operations o`,
      ),
  );
  return rows.map((found) => found.row).join('\n');
}

/** Product sources that name the gate's tables or its readiness function. */
function namingTheGate(): string[] {
  const root = new URL('../../', import.meta.url).pathname;
  return ['packages', 'apps']
    .flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).map((f) => join(dir, f)),
    )
    .filter((file) => /\.(ts|tsx|mjs)$/u.test(file) && !file.includes('node_modules'))
    .filter((file) =>
      /ops\.(gate_items|installation)|first_client_readiness/u.test(
        readFileSync(join(root, file), 'utf8'),
      ),
    )
    .toSorted();
}

describe.skipIf(serverUrl === undefined)('S0-5 isolation', () => {
  beforeAll(prepare, 300_000);

  afterAll(async () => {
    await gate?.harness.close();
  });

  it("S0-5 isolation: another business is shut by the same open items and learns their names alone; alpha's task is answered as a made-up one, and bravo moves nothing", async () => {
    expect(await anotherBusiness()).toStrictEqual([]);
    // The audit keeps the evidence's digest alone; bravo's holds nothing of alpha's.
    const { alpha, bravo } = gate.harness.world;
    const [inAlpha, inBravo] = await Promise.all([auditOf(alpha), auditOf(bravo)]);
    expect(inAlpha).not.toContain(CANARY);
    expect(inBravo).not.toContain(CANARY);
    expect(inBravo).not.toContain(tasks.b);
  });

  it("S0-5 isolation: another client in the same business is answered by authority, as a made-up id, never by the gate; the gate shuts the caller's own client", async () => {
    expect(shut(await asCleo(tasks.a))).toStrictEqual([409, 'GATE_SHUT', OPEN, false]);
    const [one, two] = gate.harness.clients.filter((client) => client.businessKey === 'alpha');
    const external: Send = async (id) => await send(gate, COMMENT, await comment(id), one!.token);
    expect([
      ...(await crossing('Cleo on client B', asCleo, tasks.b, [403, 'SCOPE_NOT_GRANTED'])),
      ...(await crossing('client 1 on client 2', external, two!.task, [403, 'SCOPE_NOT_GRANTED'])),
    ]).toStrictEqual([]);
  });

  it('S0-5 isolation: another task under a live delegation is answered by the delegation, as a made-up id, never by the gate; the gate shuts the delegated task', async () => {
    expect(shut(await asAgent(tasks.delegated))).toStrictEqual([409, 'GATE_SHUT', OPEN, false]);
    expect(
      await crossing('the agent on client B', asAgent, tasks.b, [403, 'DELEGATION_OUT_OF_PURPOSE']),
    ).toStrictEqual([]);
  });

  it('S0-5 isolation: only the gate commands and the readiness check name the gate tables, so no read, list, count or export reaches them', () => {
    expect(namingTheGate()).toStrictEqual([
      'packages/core-commands/src/commands/first-client-gate.ts',
      'packages/core-commands/src/commands/gate-write.ts',
      'packages/core-wire/src/data-effects.ts',
    ]);
  });
});
