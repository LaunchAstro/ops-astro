// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's named cases over one seeded world */
//
// C31: the credentials screen's custody command, over HTTP against a real
// database. Each case is named after the acceptance line or supporting
// checklist line it proves (U33, #494).
//
// The value a caller sets is sealed to the broker's public key before any
// statement is built, and no path hands it back. So the cases below plant a
// canary value and then look everywhere it could have gone: every answer,
// everything the process wrote to its output, and every row of every table.

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import {
  generateSealingPair,
  markSecretUsed,
  open,
  seal,
} from '../../packages/core-records/src/custody/index.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import {
  comparablePayload,
  requestDigest,
} from '../../packages/core-commands/src/commands/payload.ts';
import type { UncheckedRequest } from '../../packages/core-commands/src/commands/requests.ts';
import { payloadDigest } from '../../packages/core-digest/src/index.ts';
import { credentialKeyring } from '../../packages/core-records/src/authority/credential-keys.ts';
import { createClient } from '../../packages/core-records/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';

const serverUrl = databaseUrlFromEnvironment();
const CANARY = `canary-${randomUUID()}-do-not-log`;
const CANARY_HEX = Buffer.from(CANARY).toString('hex');

interface SecretView {
  readonly id: string;
  readonly name: string;
  readonly clientId: string | null;
  readonly state: 'set' | 'not set';
  readonly setAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revision: number;
}

/** A real client of the transaction's business. */
async function madeClient(
  tx: Parameters<typeof createClient>[0],
  actorId: string,
): Promise<string> {
  const made = await createClient(tx, `Client ${randomUUID()}`, actorId);
  if (!made.ok) throw new Error('c31: the client was not made');
  return made.value;
}

/** A keyring of fixed test keys, the first id active. */
const ringOf = (active: string, ...held: [string, number][]) => ({
  ok: true as const,
  keys: credentialKeyring(active, new Map(held.map(([id, fill]) => [id, Buffer.alloc(32, fill)]))),
});
const plainDigest = (operationId: string, body: Readonly<Record<string, unknown>>): string =>
  payloadDigest(comparablePayload({ command: 'secret.set', operationId, ...body }));

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C31 credentials screen (custody)', () => {
  const pair = generateSealingPair('test/c31@1');
  let controls: Controls;
  let admin: Member;
  let plain: Member;
  let clientHolder: Member;
  let bravoAdmin: Member;
  let clientA: string;
  let clientB: string;
  let bravoClient: string;
  const answers: Answer[] = [];
  const output: string[] = [];

  const as = async (
    who: Member,
    name: string,
    body: Readonly<Record<string, unknown>>,
    business = 'alpha',
  ): Promise<Answer> => {
    const answer = await post(
      controls.api,
      path(business, name),
      { operationId: randomUUID(), ...body },
      authorised(await tokenFor(who.presented.subject)),
    );
    answers.push(answer);
    return answer;
  };

  const list = async (who: Member, business = 'alpha'): Promise<readonly SecretView[]> => {
    const answer = await as(who, 'secret.list', {}, business);
    expect(answer.status).toBe(200);
    return answer.body['secrets'] as readonly SecretView[];
  };

  const set = async (
    name: string,
    value: string,
    extra: Readonly<Record<string, unknown>> = {},
    who: Member = admin,
  ): Promise<Answer> => await as(who, 'secret.set', { name, value, ...extra });

  const rowCount = async (): Promise<number> =>
    await controls.count('select count(*) as n from public.custody_secrets', []);

  beforeAll(async () => {
    // Everything the process writes goes into `output` as well as through.
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        output.push(String(chunk));
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = console[method].bind(console);
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(
          args.map((one) => (typeof one === 'string' ? one : JSON.stringify(one))).join(' '),
        );
        original(...args);
      });
    }

    controls = await createControls('c31', { custody: pair.key });
    const { db, business } = controls.fixture;
    admin = controls.manager;
    plain = await enrol(db.app, business, 'plain');
    clientHolder = await enrol(db.app, business, 'clientholder');
    await db.app.withBusiness(business, async (tx) => {
      clientA = await madeClient(tx, admin.actorId);
      clientB = await madeClient(tx, admin.actorId);
      await grantTo(tx, admin, 'manage', { kind: 'business', id: null }, false, 'custody');
      await grantTo(tx, plain, 'read', { kind: 'business', id: null }, false, 'custody');
      await grantTo(tx, plain, 'write', { kind: 'business', id: null }, false, 'custody');
      await grantTo(tx, clientHolder, 'manage', { kind: 'party', id: clientA }, false, 'custody');
    });
    const bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
    bravoAdmin = await enrol(db.app, bravo, 'bravoadmin');
    await db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bravoAdmin, 'manage', { kind: 'business', id: null }, false, 'custody');
      bravoClient = await madeClient(tx, bravoAdmin.actorId);
    });
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await controls?.drop();
  });

  it('C31 owner check: a set key shows "set" with no value, and a cleared one "not set"', async () => {
    const answer = await set('xero.client-secret', CANARY);
    expect(answer.status).toBe(200);
    const shown = (await list(admin)).find((one) => one.name === 'xero.client-secret');
    expect(shown?.state).toBe('set');
    expect(shown?.clientId).toBeNull();
    expect(JSON.stringify(shown)).not.toContain(CANARY);
    expect(Object.keys(shown ?? {}).toSorted()).toStrictEqual(
      ['clientId', 'id', 'lastUsedAt', 'name', 'revision', 'setAt', 'state'].toSorted(),
    );

    const cleared = await as(admin, 'secret.clear', { secretId: shown?.id });
    expect(cleared.status).toBe(200);
    const after = (await list(admin)).find((one) => one.name === 'xero.client-secret');
    expect(after?.state).toBe('not set');
    expect(after?.setAt).toBeNull();
  });

  it("C31 a key is set only for a client of this business: bravo's client and a made-up one are refused, nothing written", async () => {
    const before = await rowCount();
    for (const clientId of [bravoClient, randomUUID()]) {
      // oxlint-disable-next-line no-await-in-loop -- each refusal is counted against the same rows
      const answer = await set('foreign.client', `${CANARY}-foreign`, { clientId });
      expect(answer.status, clientId).toBe(404);
      expect(answer.body['code']).toBe('NOT_FOUND');
      expect(answer.body['names']).toStrictEqual(['clientId']);
      expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    }
    expect(await rowCount()).toBe(before);
  });

  it('C31 every change is recorded and joins the audit chain', async () => {
    const answer = await set('ads.token', `${CANARY}-audit`);
    const secretId = String((answer.body['detail'] as Record<string, unknown>)['secretId']);
    await as(admin, 'secret.clear', { secretId });
    const rows = await controls.fixture.db.admin.execute<{
      readonly command: string;
      readonly outcome: string;
    }>(
      `select command, outcome from public.audit_events
        where actor_id = $1 and command in ('secret.set', 'secret.clear') order by seq`,
      [admin.actorId],
    );
    expect(
      rows.filter((row) => row.command === 'secret.set' && row.outcome === 'applied').length,
    ).toBeGreaterThan(0);
    expect(
      rows.filter((row) => row.command === 'secret.clear' && row.outcome === 'applied').length,
    ).toBeGreaterThan(0);
    const { db, business } = controls.fixture;
    expect(await db.app.withBusiness(business, verifyAuditChain)).toMatchObject({
      intact: true,
      firstBreak: undefined,
    });
    const history = await controls.fixture.db.admin.execute<{
      readonly set_by_actor_id: string | null;
      readonly cleared_by_actor_id: string | null;
    }>(`select set_by_actor_id, cleared_by_actor_id from public.custody_secrets where id = $1`, [
      secretId,
    ]);
    expect(history[0]?.cleared_by_actor_id).toBe(admin.actorId);
  });

  // A secret's stored digest, read as anyone holding the rows can read it.
  const RING_A = ringOf('digest@1', ['digest@1', 1]);
  const apiWith = (delegation: Parameters<Controls['fixture']['compose']>[0]): Hono =>
    controls.fixture.compose({ custody: pair.key, ...delegation });
  const setOn = async (
    api: Hono,
    operationId: string,
    body: Readonly<Record<string, unknown>>,
    who: Member = admin,
    business = 'alpha',
  ): Promise<Answer> =>
    await post(
      api,
      path(business, 'secret.set'),
      { operationId, ...body },
      authorised(await tokenFor(who.presented.subject)),
    );
  const digestsOf = async (
    operationId: string,
    actorId = admin.actorId,
  ): Promise<
    readonly { readonly source: string; readonly digest: string; readonly outcome: string }[]
  > =>
    await controls.fixture.db.admin.execute(
      `select 'operations' as source, payload_digest as digest, outcome from public.operations
        where operation_id = $1 and actor_id = $2
       union all
       select 'audit', payload_digest, outcome from public.audit_events
        where operation_id = $1 and actor_id = $2`,
      [operationId, actorId],
    );

  it('C31 a stored secret digest needs the keyring: no row holds the plain digest, and another keyring computes another', async () => {
    const api = apiWith({ delegation: RING_A });
    const operationId = randomUUID();
    const body = { name: 'short.pin', value: 'pin-4821' };
    expect((await setOn(api, operationId, body)).status).toBe(200);
    const rows = await digestsOf(operationId);
    expect(new Set(rows.map((row) => row.source))).toEqual(new Set(['operations', 'audit']));
    expect(rows.filter((row) => row.digest === plainDigest(operationId, body))).toEqual([]);
    const request: UncheckedRequest = { command: 'secret.set', operationId, ...body };
    const owner = { businessId: controls.fixture.business, actorId: admin.actorId };
    const here = requestDigest(owner, request, RING_A).digest;
    const elsewhere = requestDigest(owner, request, ringOf('digest@9', ['digest@9', 9])).digest;
    expect(rows.find((row) => row.source === 'operations')?.digest).toBe(here);
    expect(elsewhere, 'the digest rests on the key').not.toBe(here);
  });

  it('C31 a refused short or non-string secret value keeps no plain digest in either row', async () => {
    const api = apiWith({ delegation: RING_A });
    for (const value of ['hunter2', ['hunter2'], { v: 'hunter2' }, 12345678, null, true]) {
      const operationId = randomUUID();
      const body = { name: 'refused.pin', value };
      const label = JSON.stringify(value);
      // oxlint-disable-next-line no-await-in-loop -- each value is its own attempt
      expect((await setOn(api, operationId, body)).status, label).toBe(422);
      // oxlint-disable-next-line no-await-in-loop -- read after its own attempt
      const rows = await digestsOf(operationId);
      expect(new Set(rows.map((row) => row.source)), label).toEqual(
        new Set(['operations', 'audit']),
      );
      expect(
        rows.filter((row) => row.digest === plainDigest(operationId, body)),
        label,
      ).toEqual([]);
    }
  });

  it('C31 a failed secret attempt records no plain digest of its body', async () => {
    const broken = { keyId: 'broken@1', publicKey: generateKeyPairSync('ed25519').publicKey };
    const api = controls.fixture.compose({ custody: broken, delegation: RING_A });
    const operationId = randomUUID();
    const body = { name: 'failed.key', value: 'failed-value-1234' };
    expect((await setOn(api, operationId, body)).status).toBeGreaterThanOrEqual(500);
    const rows = await digestsOf(operationId);
    expect(rows.map((row) => row.outcome)).toContain('failed');
    expect(rows.filter((row) => row.digest === plainDigest(operationId, body))).toEqual([]);
  });

  it('C31 a secret retry replays, another value is refused, and key order does not matter', async () => {
    const api = apiWith({ delegation: RING_A });
    const operationId = randomUUID();
    const first = await setOn(api, operationId, { name: 'retry.key', value: 'retry-value-1' });
    expect(first.status).toBe(200);
    expect(await setOn(api, operationId, { value: 'retry-value-1', name: 'retry.key' })).toEqual(
      first,
    );
    const other = await setOn(api, operationId, { name: 'retry.key', value: 'retry-value-2' });
    expect(other.body['code']).toBe('OPERATION_ID_REUSED');
    const objectId = randomUUID();
    const refused = await setOn(api, objectId, { name: 'retry.obj', value: { a: 'x', b: 'y' } });
    expect(refused.status).toBe(422);
    expect(await setOn(api, objectId, { name: 'retry.obj', value: { b: 'y', a: 'x' } })).toEqual(
      refused,
    );
  });

  it('C31 the same secret body from two businesses or two people stores unrelated digests', async () => {
    const api = apiWith({ delegation: RING_A });
    const { db, business } = controls.fixture;
    const second = await enrol(db.app, business, `second${randomUUID().slice(0, 6)}`);
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, second, 'manage', { kind: 'business', id: null }, false, 'custody');
    });
    // A business of its own, so bravo's list stays as the isolation case reads it.
    const charlie = await insertBusiness(db.app, 'charlie');
    await installSpine(db.app, charlie);
    const charlieAdmin = await enrol(db.app, charlie, 'charlieadmin');
    await db.app.withBusiness(charlie, async (tx) => {
      await grantTo(tx, charlieAdmin, 'manage', { kind: 'business', id: null }, false, 'custody');
    });
    const operationId = randomUUID();
    const body = { name: 'shared.key', value: 'shared-value-1' };
    const sets: [Member, string][] = [
      [admin, 'alpha'],
      [second, 'alpha'],
      [charlieAdmin, 'charlie'],
    ];
    const digests: string[] = [];
    for (const [who, where] of sets) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      expect((await setOn(api, operationId, body, who, where)).status, where).toBe(200);
      // oxlint-disable-next-line no-await-in-loop -- read after its own set
      const rows = await digestsOf(operationId, who.actorId);
      digests.push(rows.find((row) => row.source === 'operations')?.digest ?? '');
    }
    expect(new Set(digests).size).toBe(3);
  });

  it('C31 a secret retry digested under an older held key replays, and once that key is retired it is refused', async () => {
    const operationId = randomUUID();
    const body = { name: 'rotated.key', value: 'rotated-value-1' };
    const first = await setOn(apiWith({ delegation: RING_A }), operationId, body);
    expect(first.status).toBe(200);
    const rotated = ringOf('digest@2', ['digest@1', 1], ['digest@2', 2]);
    expect(await setOn(apiWith({ delegation: rotated }), operationId, body)).toEqual(first);
    const retired = ringOf('digest@2', ['digest@2', 2]);
    const refused = await setOn(apiWith({ delegation: retired }), operationId, body);
    expect(refused.body['code']).toBe('OPERATION_ID_REUSED');
  });

  it('C31 a secret request registered before digests were keyed still replays, and writes no plain digest', async () => {
    const api = apiWith({ delegation: RING_A });
    const body = { name: 'legacy.key', value: 'legacy-value-1' };
    const original = randomUUID();
    const first = await setOn(api, original, body);
    expect(first.status).toBe(200);
    // The row an earlier release left: the same answer under the plain digest.
    const operationId = randomUUID();
    await controls.fixture.db.admin.execute(
      `insert into public.operations
         (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result,
          record_id, revision)
       select business_id, gen_random_uuid(), $2, command, actor_id, $3, outcome, result,
              record_id, revision
         from public.operations where operation_id = $1 and actor_id = $4`,
      [original, operationId, plainDigest(operationId, body), admin.actorId],
    );
    expect(await setOn(api, operationId, body)).toEqual(first);
    const other = await setOn(api, operationId, { ...body, value: 'legacy-value-2' });
    expect(other.body['code']).toBe('OPERATION_ID_REUSED');
    const audit = (await digestsOf(operationId)).filter((row) => row.source === 'audit');
    expect(audit.map((row) => row.outcome)).toContain('replayed');
    expect(audit.filter((row) => row.digest === plainDigest(operationId, body))).toEqual([]);
  });

  it('C31 without the keyring a secret is refused, nothing is registered, and the key later applies it', async () => {
    const none = apiWith({ delegation: { ok: false, problem: 'no keyring in this case' } });
    const operationId = randomUUID();
    const bodies = [
      { name: 'unkeyed.key', value: 'unkeyed-value-1' },
      { name: 'unkeyed.key', value: 'unkeyed-value-2' },
    ];
    for (const body of bodies) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after the other
      const answer = await setOn(none, operationId, body);
      expect(answer.status).toBe(501);
      expect(answer.body['code']).toBe('DEPENDENCY_NOT_LANDED');
    }
    const rows = await digestsOf(operationId);
    expect(rows.filter((row) => row.source === 'operations')).toEqual([]);
    const plainOnes = new Set(bodies.map((body) => plainDigest(operationId, body)));
    expect(rows.filter((row) => plainOnes.has(row.digest))).toEqual([]);
    expect(
      (await setOn(apiWith({ delegation: RING_A }), operationId, bodies[1] ?? {})).status,
    ).toBe(200);
  });

  it('C31 commands that carry no secret digest exactly as before', async () => {
    const api = apiWith({ delegation: RING_A });
    const commands: [string, Readonly<Record<string, unknown>>][] = [
      ['secret.clear', { secretId: randomUUID() }],
      ['client.create', { name: `Golden ${randomUUID()}` }],
    ];
    const headers = authorised(await tokenFor(admin.presented.subject));
    for (const [command, body] of commands) {
      const operationId = randomUUID();
      // oxlint-disable-next-line no-await-in-loop -- one command at a time
      await post(api, path('alpha', command), { operationId, ...body }, headers);
      // oxlint-disable-next-line no-await-in-loop -- read after its own command
      const rows = await digestsOf(operationId);
      expect(rows.length, command).toBeGreaterThan(0);
      const golden = payloadDigest(
        comparablePayload({ command, operationId, ...body } as UncheckedRequest),
      );
      expect(new Set(rows.map((row) => row.digest)), command).toEqual(new Set([golden]));
    }
  });

  it('C31 refusal custody:manage: read and write holders are refused set, clear and list', async () => {
    const before = await rowCount();
    const setting = await set('plain.try', `${CANARY}-plain`, {}, plain);
    expect(setting.status).toBe(403);
    expect(setting.body['code']).toBe('SCOPE_NOT_GRANTED');
    const target = await set('plain.target', `${CANARY}-target`);
    const secretId = String((target.body['detail'] as Record<string, unknown>)['secretId']);
    const clearing = await as(plain, 'secret.clear', { secretId });
    expect(clearing.status).toBe(403);
    expect(clearing.body['code']).toBe('SCOPE_NOT_GRANTED');
    const listing = await as(plain, 'secret.list', {});
    expect(listing.status).toBe(403);
    expect(listing.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(await rowCount()).toBe(before + 1);
    const still = (await list(admin)).find((one) => one.id === secretId);
    expect(still?.state).toBe('set');
  });

  it('C31 refusal custody:manage: an agent never holds it, even under a live delegation', async () => {
    const task = await controls.createTask('agent crossing');
    const proposal = await controls.propose(task.id, task.revision);
    const reservationId = await controls.approve(proposal);
    const picked = await controls.pickup(reservationId);
    const credential = String(picked['credential']);
    const before = await rowCount();
    for (const [name, body] of [
      ['secret.list', {}],
      ['secret.set', { name: 'agent.try', value: `${CANARY}-agent` }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await controls.asAgent(name, body, credential);
      answers.push(answer);
      expect(answer.status).toBe(403);
      expect(String(answer.body['code'])).toMatch(/^(DELEGATION_|AUTH_)/u);
      expect(answer.body['secrets']).toBeUndefined();
    }
    expect(await rowCount()).toBe(before);
  });

  it('C31 isolation: another business never sees, counts or clears these secrets', async () => {
    const mine = await set('isolation.alpha', `${CANARY}-alpha`);
    const secretId = String((mine.body['detail'] as Record<string, unknown>)['secretId']);
    const theirs = await list(bravoAdmin, 'bravo');
    expect(theirs).toStrictEqual([]);
    const clearing = await as(bravoAdmin, 'secret.clear', { secretId }, 'bravo');
    expect(clearing.status).toBe(404);
    expect(clearing.body['code']).toBe('NOT_FOUND');
    const fabricated = await as(bravoAdmin, 'secret.clear', { secretId: randomUUID() }, 'bravo');
    const malformed = await as(bravoAdmin, 'secret.clear', { secretId: 'not-a-uuid' }, 'bravo');
    for (const other of [fabricated, malformed]) {
      expect(other.status).toBe(clearing.status);
      expect(other.body).toStrictEqual(clearing.body);
    }
    expect((await list(admin)).find((one) => one.id === secretId)?.state).toBe('set');
  });

  it('C31 the list says who may change keys: a business-wide holder may, a client-scoped one may not', async () => {
    const changeable = async (who: Member): Promise<unknown> =>
      (await as(who, 'secret.list', {})).body['canChange'];
    expect(await changeable(admin)).toBe(true);
    expect(await changeable(clientHolder)).toBe(false);
  });

  it('C31 isolation: a client-scoped holder sees that client only, and writes nothing', async () => {
    await set('google.refresh', `${CANARY}-a`, { clientId: clientA });
    await set('google.refresh', `${CANARY}-b`, { clientId: clientB });
    const shown = await list(clientHolder);
    expect(shown.length).toBeGreaterThan(0);
    for (const one of shown) expect(one.clientId).toBe(clientA);
    const all = await list(admin);
    const other = all.find((one) => one.clientId === clientB);
    expect(other).toBeDefined();
    expect(JSON.stringify(shown)).not.toContain(clientB);
    expect(JSON.stringify(shown)).not.toContain(other?.id ?? 'none');

    const before = await rowCount();
    const setting = await set('google.refresh', `${CANARY}-c`, { clientId: clientA }, clientHolder);
    expect(setting.status).toBe(403);
    const clearing = await as(clientHolder, 'secret.clear', { secretId: other?.id });
    expect(clearing.status).toBe(403);
    expect(JSON.stringify(clearing.body)).not.toContain(clientB);
    expect(await rowCount()).toBe(before);
    expect((await list(admin)).find((one) => one.id === other?.id)?.state).toBe('set');
  });

  it('C31 last used readback: a use moves last used, and setting again does not', async () => {
    const answer = await set('used.key', `${CANARY}-used`);
    const secretId = String((answer.body['detail'] as Record<string, unknown>)['secretId']);
    expect((await list(admin)).find((one) => one.id === secretId)?.lastUsedAt).toBeNull();
    const { db, business } = controls.fixture;
    await db.app.withBusiness(business, async (tx) => {
      expect(await markSecretUsed(tx, secretId)).toBe(true);
    });
    const used = (await list(admin)).find((one) => one.id === secretId)?.lastUsedAt;
    expect(used).not.toBeNull();
    await set('used.key', `${CANARY}-used-again`);
    expect((await list(admin)).find((one) => one.id === secretId)?.lastUsedAt).toBe(used);
  });

  it('C31 a stale revision is refused and the value stays', async () => {
    const first = await set('stale.key', `${CANARY}-1`);
    const revision = Number(first.body['revision']);
    expect((await set('stale.key', `${CANARY}-2`, { expectedRevision: revision })).status).toBe(
      200,
    );
    const stale = await set('stale.key', `${CANARY}-3`, { expectedRevision: revision });
    expect(stale.status).toBe(409);
    expect(stale.body['code']).toBe('VERSION_STALE');
  });

  it('C31 two setters at once leave one row, both applied in turn', async () => {
    // Two connections, and neither transaction runs until both are open, so
    // the setters overlap and race on the insert.
    const pool = connect(controls.fixture.db.appUrl, { max: 2 });
    let opened = 0;
    let bothOpen!: () => void;
    const together = new Promise<void>((resolve) => {
      bothOpen = resolve;
    });
    const racing: Database = {
      log: pool.log,
      close: () => Promise.resolve(),
      withBusiness: async (business, run) =>
        await pool.withBusiness(business, async (tx) => {
          opened += 1;
          if (opened === 2) bothOpen();
          await together;
          return await run(tx);
        }),
    };
    const api = controls.fixture.compose({ custody: pair.key }, undefined, racing);
    const headers = authorised(await tokenFor(admin.presented.subject));
    const setter = async (value: string): Promise<Answer> => {
      const body = { operationId: randomUUID(), name: 'race.key', value };
      const answer = await post(api, path('alpha', 'secret.set'), body, headers);
      answers.push(answer);
      return answer;
    };
    try {
      const [one, two] = await Promise.all([setter(`${CANARY}-r1`), setter(`${CANARY}-r2`)]);
      expect([one.status, two.status]).toStrictEqual([200, 200]);
    } finally {
      await pool.close();
    }
    const rows = (await list(admin)).filter((row) => row.name === 'race.key');
    expect(rows.length).toBe(1);
    expect(rows[0]?.revision).toBe(2);
  });

  it('C31 malformed input is refused by field and never echoed', async () => {
    const before = await rowCount();
    for (const body of [
      { name: 'Bad Name!', value: `${CANARY}-bad` },
      { name: 'ok.name', value: 42 },
      { name: 'ok.name', value: '' },
      { name: 'ok.name', value: `${CANARY}-x`.padEnd(9_000, 'x') },
      { name: 'ok.name', value: `${CANARY}-y`, clientId: 'not-a-uuid' },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one body at a time
      const answer = await as(admin, 'secret.set', body);
      expect(answer.status).toBe(422);
      expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
    }
    expect(await rowCount()).toBe(before);
  });

  it('C31 no session token: a chat product session is refused by field and nothing is stored', async () => {
    // AW-01 and C60: the product never stores a Claude.ai or ChatGPT session
    // token, and custody's set is the one way a credential is stored. Each
    // shape custody refuses at load is refused here, bare, as a cookie pair
    // and percent-encoded, and never echoed.
    const before = await rowCount();
    for (const value of [
      `sk-ant-sid01-${CANARY}`,
      `sessionKey=sk-ant-sid01-${CANARY}`,
      encodeURIComponent(`__Secure-next-auth.session-token=${CANARY}`),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one body at a time
      const answer = await set('session.try', value);
      expect(answer.status).toBe(422);
      expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
      expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    }
    expect(await rowCount()).toBe(before);
    expect(await list(admin)).not.toContainEqual(expect.objectContaining({ name: 'session.try' }));
  });

  it('C31 no broker key configured: set refuses and stores nothing', async () => {
    const bare = controls.fixture.compose({ custody: undefined });
    const before = await rowCount();
    const answer = await post(
      bare,
      path('alpha', 'secret.set'),
      { operationId: randomUUID(), name: 'nokey.key', value: `${CANARY}-nokey` },
      authorised(await tokenFor(admin.presented.subject)),
    );
    answers.push(answer);
    expect(answer.status).toBe(501);
    expect(answer.body['code']).toBe('DEPENDENCY_NOT_LANDED');
    expect(await rowCount()).toBe(before);
  });

  it('C31 the application role cannot select a sealed value', async () => {
    const { db, business } = controls.fixture;
    await expect(
      db.app.withBusiness(
        business,
        async (tx) => await tx.query('select sealed from public.custody_secrets'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('C31 a sealed value opens only with the broker key', () => {
    const at = {
      businessId: controls.fixture.business,
      name: 'canary.key',
      scope: { kind: 'business', id: null },
    } as const;
    const sealed = seal(CANARY, pair.key, at);
    expect(sealed.sealed.toString('hex')).not.toContain(CANARY_HEX);
    expect(open(sealed, pair.privateKey, at)).toBe(CANARY);
    const stranger = generateSealingPair('test/c31@1');
    expect(() => open(sealed, stranger.privateKey, at)).toThrow();
  });

  it('C31 parity: the three commands are catalogued custody:manage, person only', () => {
    for (const name of ['secret.list', 'secret.set', 'secret.clear']) {
      const row = COMMAND_SURFACE.find((one) => one.name === name);
      expect(row?.collection).toBe('custody');
      expect(row?.action).toBe('manage');
      expect(row?.agent).toBe('never');
    }
  });

  it('C31 canary: the planted value never reaches an answer, the output or any table', async () => {
    const { db } = controls.fixture;
    for (const answer of answers) expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    expect(output.join('\n')).not.toContain(CANARY);
    const tables = await db.admin.execute<{ readonly name: string }>(
      `select table_name as name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const dumps = await Promise.all(
      tables.map(async ({ name }) => {
        const rows = await db.admin.execute<{ readonly dump: string | null }>(
          `select string_agg(t::text, E'\\n') as dump from public."${name}" t`,
        );
        return rows[0]?.dump ?? '';
      }),
    );
    const everything = dumps.join('\n');
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain(CANARY_HEX);
    expect(everything.length).toBeGreaterThan(0);
  });
});
