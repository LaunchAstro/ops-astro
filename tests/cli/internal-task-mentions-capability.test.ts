// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  tokenFor,
  type Caller,
  type World,
} from '../acceptance/world.ts';
import { enrol, grantTo, shareWithClient, type Member } from '../commands/fixture.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import { readAuthenticationAttempts } from '../../packages/core-records/src/identity/authentication-attempts.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { runCli, serveApi, type ServedApi } from './cli-process-harness.ts';

let world: World;
let api: ServedApi;
const member = (who: Caller): Member => {
  if (who.personId === null || who.actorId === null) throw new Error('Expected enrolled caller');
  return { personId: who.personId, actorId: who.actorId, presented: who.presented };
};
const ask = (command: string, body: Readonly<Record<string, unknown>>, token = world.ada.token) =>
  call(world.api, personPath('alpha', '/' + command.replaceAll('.', '/')), body, bearer(token));
const cli = (command: string, body: Readonly<Record<string, unknown>>) =>
  runCli([command, '--json', JSON.stringify(body)], {
    OPS_ASTRO_API_URL: api.origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: world.ada.token,
  });

async function freshTask(title: string) {
  const made = await ask('task.create', { operationId: randomUUID(), fields: { title } });
  expect(made.status, made.text).toBe(200);
  const id = made.body['recordId'];
  const revision = made.body['revision'];
  if (typeof id !== 'string' || typeof revision !== 'number') throw new Error('Expected task');
  return { recordId: id, expectedRevision: revision };
}
const domain = () =>
  world.db.app.withBusiness(world.alpha, async (tx) => ({
    records: await tx.query('select id, revision::text, data from public.records order by id'),
    inbox: await tx.query('select * from public.inbox_items order by id'),
    grants: await tx.query('select * from public.grants order by id'),
  }));
const events = () => world.db.app.withBusiness(world.alpha, (tx) => readAuditEvents(tx));
const authentication = () =>
  world.db.app.withBusiness(world.alpha, (tx) =>
    readAuthenticationAttempts(tx, world.ada.presented),
  );

async function grantRecipient(taskId: string) {
  return await world.db.app.withBusiness(world.alpha, (tx) =>
    grantTo(tx, member(world.noah), 'read', { kind: 'record', id: taskId }),
  );
}
function note(
  task: { readonly recordId: string; readonly expectedRevision: number },
  mentions: readonly string[],
) {
  return {
    ...task,
    operationId: randomUUID(),
    body: 'P03 internal durable canary',
    audience: 'internal',
    commentType: 'note',
    mentions,
  };
}

async function proveReadEffects(taskId: string) {
  const before = await events();
  const authBefore = await authentication();
  const domainBefore = await domain();
  expect((await ask('person.list', {})).status).toBe(200);
  expect((await ask('task.read', { recordId: taskId })).status).toBe(200);
  const after = await events();
  expect(after.slice(0, before.length)).toEqual(before);
  expect(
    after.slice(before.length).map((event) => ({
      command: event.command,
      operationId: event.operation_id,
      outcome: event.outcome,
    })),
  ).toEqual([
    { command: 'person.list', operationId: null, outcome: 'applied' },
    { command: 'task.read', operationId: null, outcome: 'applied' },
  ]);
  expect(await authentication()).toHaveLength(authBefore.length + 2);
  expect(await domain()).toEqual(domainBefore);
}

async function proveInbox(taskId: string, body: string) {
  const detail = await ask('task.read', { recordId: taskId });
  expect(detail.body).toMatchObject({ task: { comments: [expect.objectContaining({ body })] } });
  const recipient = await ask('inbox.read', {}, world.noah.token);
  expect(recipient.body).toMatchObject({
    inbox: [
      expect.objectContaining({
        reason: 'mention',
        subjectRecordId: taskId,
        factKind: 'record',
      }),
    ],
  });
  const items = await world.db.app.withBusiness(world.alpha, (tx) =>
    tx.query(
      'select recipient_person_id::text from public.inbox_items where subject_record_id = $1',
      [taskId],
    ),
  );
  expect(items).toEqual([{ recipient_person_id: world.noah.personId }]);
}

async function proveStoredEffect(before: Awaited<ReturnType<typeof domain>>) {
  const after = await domain();
  expect(after.records).toHaveLength(before.records.length + 1);
  expect(after.records).toEqual(expect.arrayContaining([...before.records]));
  expect(after.inbox).toHaveLength(before.inbox.length + 1);
  expect(after.inbox).toEqual(expect.arrayContaining([...before.inbox]));
  expect(after.grants).toEqual(before.grants);
}

async function proveClientView(taskId: string, client: Member, body: string) {
  const token = await tokenFor(client.presented.subject);
  const shared = await ask('task.read', { recordId: taskId }, token);
  expect(shared.status, shared.text).toBe(200);
  expect(shared.body).toMatchObject({ sharedTask: { comments: [] } });
  expect(shared.body).not.toHaveProperty('task');
  expect(shared.text).not.toContain(body);
  expect(shared.text).not.toContain('internalCount');
  expect((await ask('person.list', {}, token)).code).toBe('SCOPE_NOT_GRANTED');
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await createWorld('p03mentions');
  api = await serveApi(world);
}, 180_000);
afterAll(async () => {
  await api?.stop();
  await world?.close();
}, 60_000);

it.skipIf(serverUrl === undefined)(
  'keeps one comment and intended inbox item through server reconnect and exact CLI replay, with no added access',
  async () => {
    const task = await freshTask('P03 durable mention');
    await grantRecipient(task.recordId);
    const client = await shareWithClient(
      world.db.app,
      world.alpha,
      member(world.ada),
      task.recordId,
    );
    await proveReadEffects(task.recordId);
    const before = await domain();
    const request = note(task, [member(world.noah).personId, member(world.ada).personId]);
    const posted = await cli('task.comment', request);
    expect(posted.code, posted.stderr).toBe(0);
    await api.stop();
    await world.db.closeSessions();
    api = await serveApi(world);
    const replayed = await cli('task.comment', request);
    expect(replayed.code, replayed.stderr).toBe(0);
    expect(replayed.json).toEqual(posted.json);
    await proveInbox(task.recordId, request.body);
    await proveClientView(task.recordId, client, request.body);
    await proveStoredEffect(before);
    expect(
      (await events())
        .filter((event) => event.operation_id === request.operationId)
        .map((event) => ({ command: event.command, outcome: event.outcome })),
    ).toEqual([
      { command: 'task.comment', outcome: 'applied' },
      { command: 'task.comment', outcome: 'replayed' },
    ]);
  },
  90_000,
);

it.skipIf(serverUrl === undefined)(
  'refuses a selected still-listed recipient after record-read revocation without comment, inbox or grant effects',
  async () => {
    const task = await freshTask('P03 revoke mention');
    const grant = await grantRecipient(task.recordId);
    expect((await ask('person.list', {})).body).toMatchObject({
      persons: expect.arrayContaining([expect.objectContaining({ personId: world.noah.personId })]),
    });
    await world.db.app.withBusiness(world.alpha, (tx) => revokeGrant(tx, grant));
    expect((await ask('person.list', {})).body).toMatchObject({
      persons: expect.arrayContaining([expect.objectContaining({ personId: world.noah.personId })]),
    });
    const before = await domain();
    const request = note(task, [member(world.noah).personId]);
    const refused = await ask('task.comment', request);
    expect(refused.code).toBe('MENTION_NOT_READABLE');
    expect((await ask('task.read', { recordId: task.recordId }, world.noah.token)).code).toBe(
      'SCOPE_NOT_GRANTED',
    );
    expect((await ask('task.read', { recordId: task.recordId })).body).toMatchObject({
      task: { comments: [] },
    });
    expect(await domain()).toEqual(before);
    expect(
      (await events())
        .filter((event) => event.operation_id === request.operationId)
        .map((event) => event.outcome),
    ).toEqual(['refused']);
  },
);

it.skipIf(serverUrl === undefined)(
  'API and CLI refuse foreign and fabricated mention IDs without private names or domain effects',
  async () => {
    const task = await freshTask('P03 foreign mention');
    const foreign = await enrol(world.db.app, world.bravo, 'P03 foreign private name canary');
    const before = await domain();
    const fromApi = await ask('task.comment', note(task, [foreign.personId]));
    const absentId = randomUUID();
    const fabricated = await cli('task.comment', note(task, [absentId]));
    expect(fromApi.code).toBe('MENTION_NOT_READABLE');
    expect(fabricated.code).not.toBe(0);
    expect(fabricated.json).toMatchObject({ code: 'MENTION_NOT_READABLE' });
    expect(JSON.stringify(fabricated.json).replaceAll(absentId, 'recipient')).toBe(
      JSON.stringify(fromApi.body).replaceAll(foreign.personId, 'recipient'),
    );
    expect(fromApi.text).not.toContain('P03 foreign private name canary');
    expect(fabricated.stdout).not.toContain('P03 foreign private name canary');
    expect((await ask('task.read', { recordId: task.recordId })).body).toMatchObject({
      task: { comments: [] },
    });
    expect(await domain()).toEqual(before);
  },
  90_000,
);
