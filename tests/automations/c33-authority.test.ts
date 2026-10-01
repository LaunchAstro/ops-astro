// SPDX-License-Identifier: AGPL-3.0-only
//
// C33's authority cases through the real API route (U36, #483): the refusal
// per key, the agent refused, the audit readback, three isolation crossings and
// the surface parity. The world is `registry-world.ts`; the command cases are in
// `c33-commands.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { createRegistryWorld, detail, RELEASE, type RegistryWorld } from './registry-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const row = (name: string): readonly unknown[] => {
  const one = COMMAND_SURFACE.find((command) => command.name === name);
  return [one?.kind, one?.collection, one?.action, one?.agent, one?.authorisedOn];
};

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C33 registry authority', () => {
  let w: RegistryWorld;

  beforeAll(async () => {
    w = await createRegistryWorld('c33a');
  }, 120_000);

  afterAll(async () => {
    await w?.controls.drop();
  });

  it('C33 audit readback: each change is recorded and joins the audit chain', async () => {
    const { definitionId, versionId } = await w.define(['manual', 'scheduled']);
    const on = await w.activate(versionId);
    const activationId = String(detail(on)['activationId']);
    for (const command of ['definition.release', 'activation.change']) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time
      const events = await w.controls.fixture.db.admin.execute<{ readonly hash: string }>(
        `select hash from public.audit_events
          where actor_id = $1 and command = $2 and outcome = 'applied'`,
        [w.admin.actorId, command],
      );
      expect(events.length, command).toBeGreaterThan(0);
      for (const event of events) expect(event.hash).toMatch(/^[0-9a-f]{64}$/u);
    }
    const record = await w.controls.fixture.db.admin.execute<{
      readonly created: string;
      readonly released: string;
      readonly changed: string;
    }>(
      `select d.created_by_actor_id as created, v.released_by_actor_id as released,
              a.changed_by_actor_id as changed
         from public.automation_definitions d
         join public.definition_versions v on v.definition_id = d.id
         join public.activations a on a.version_id = v.id
        where d.id = $1 and v.id = $2 and a.id = $3`,
      [definitionId, versionId, activationId],
    );
    expect(record[0]).toStrictEqual({
      created: w.admin.actorId,
      released: w.admin.actorId,
      changed: w.admin.actorId,
    });
  });

  it('C33 refusal settings:manage: read, write, client-scoped and automation-only holders change no activation', async () => {
    const { versionId } = await w.define(['manual', 'scheduled']);
    const on = await w.activate(versionId);
    const activationId = String(detail(on)['activationId']);
    const before = await w.changes();
    for (const who of [w.reader, w.clientManager, w.automationOnly, w.plain]) {
      for (const body of [
        {},
        { activationId, mode: 'manual', everyMinutes: null, expectedRevision: 1 },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- one caller and body at a time
        const answer = await w.activate(versionId, body, who);
        expect([answer.status, answer.body['code']], who.actorId).toStrictEqual([
          403,
          'SCOPE_NOT_GRANTED',
        ]);
      }
    }
    expect(await w.changes()).toStrictEqual(before);
  });

  it('C33 refusal automation:manage: read, client-scoped and settings-only holders release no version', async () => {
    const { definitionId } = await w.define(['manual']);
    const before = await w.changes();
    for (const who of [w.reader, w.clientManager, w.settingsOnly, w.plain]) {
      for (const body of [
        { definitionId, modes: ['manual'] },
        { name: 'Theirs', kind: 'automation', modes: ['manual'] },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- one caller and body at a time
        const answer = await w.release(body, who);
        expect([answer.status, answer.body['code']], who.actorId).toStrictEqual([
          403,
          'SCOPE_NOT_GRANTED',
        ]);
      }
    }
    expect(await w.changes()).toStrictEqual(before);
  });

  it('C33 agent refused: an agent under a live delegation reads no registry and changes nothing', async () => {
    const { definitionId, versionId } = await w.define(['manual', 'scheduled']);
    const on = await w.activate(versionId);
    const activationId = String(detail(on)['activationId']);
    const task = await w.controls.createTask('agent crossing');
    const proposal = await w.controls.propose(task.id, task.revision);
    const picked = await w.controls.pickup(await w.controls.approve(proposal));
    const credential = String(picked['credential']);
    const before = await w.changes();
    for (const [name, body] of [
      ['automation.registry', {}],
      ['definition.release', { ...RELEASE, definitionId, modes: ['manual'] }],
      [
        'activation.change',
        { activationId, versionId, mode: 'manual', enabled: true, expectedRevision: 1 },
      ],
      ['activation.change', { versionId, mode: 'manual', enabled: true }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await w.controls.asAgent(name, body, credential);
      w.answers.push(answer);
      expect(answer.status, name).toBe(403);
      expect(String(answer.body['code'])).toMatch(/^(DELEGATION_|AUTH_)/u);
      expect(answer.body['definitions']).toBeUndefined();
    }
    expect(await w.changes()).toStrictEqual(before);
  });

  it('C33 isolation: another business never sees, counts or changes these automations', async () => {
    const { definitionId, versionId } = await w.define(['manual', 'scheduled']);
    const on = await w.activate(versionId);
    const activationId = String(detail(on)['activationId']);
    const theirs = await w.registry(w.bravoAdmin, 'bravo');
    expect(theirs.definitions.map((one) => one.name)).toStrictEqual([
      `Bravo digest ${w.bravoCanary}`,
    ]);
    const before = await w.changes();
    for (const [name, body] of [
      ['definition.release', { ...RELEASE, definitionId, modes: ['manual'] }],
      ['activation.change', { versionId, mode: 'manual', enabled: true }],
      [
        'activation.change',
        { activationId, versionId, mode: 'manual', enabled: false, expectedRevision: 1 },
      ],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await w.as(w.bravoAdmin, name, body, 'bravo');
      expect([answer.status, answer.body['code']], name).toStrictEqual([404, 'NOT_FOUND']);
    }
    expect(await w.changes()).toStrictEqual(before);
    const ours = await w.registry(w.admin);
    expect(JSON.stringify(ours)).not.toContain(w.bravoCanary);
  });

  it('C33 isolation: a client-scoped holder is refused the registry and shown nothing', async () => {
    await w.define(['manual']);
    const answer = await w.as(w.clientManager, 'automation.registry', {});
    expect([answer.status, answer.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
    expect(answer.body['definitions']).toBeUndefined();
    const none = await w.as(w.plain, 'automation.registry', {});
    expect([none.status, none.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
  });

  it('C33 isolation: no answer to another business or a refused caller carries a canary', () => {
    const foreign = w.answers.filter((answer) => answer.status !== 200);
    expect(foreign.length).toBeGreaterThan(0);
    for (const answer of foreign) expect(JSON.stringify(answer.body)).not.toContain(w.canary);
    const bravoRead = w.answers.filter((answer) =>
      JSON.stringify(answer.body).includes(w.bravoCanary),
    );
    for (const answer of bravoRead) expect(JSON.stringify(answer.body)).not.toContain(w.canary);
  });

  it('C33 parity: the registry is settings:read, activation.change settings:manage and definition.release automation:manage, person only', () => {
    expect(row('automation.registry')).toStrictEqual([
      'read',
      'settings',
      'read',
      'never',
      'business',
    ]);
    expect(row('activation.change')).toStrictEqual([
      'write',
      'settings',
      'manage',
      'never',
      'business',
    ]);
    expect(row('definition.release')).toStrictEqual([
      'write',
      'automation',
      'manage',
      'never',
      'business',
    ]);
  });
});
