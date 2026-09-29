// SPDX-License-Identifier: AGPL-3.0-only
//
// C33's commands through the real API route (U36, #483): a person releases a
// definition version (`definition.release`, `automation:manage`) and changes an
// activation (`activation.change`, `settings:manage`), and Settings ▸ Workflow
// triggers reads them back (`automation.registry`). Each case is named after the
// line it proves; who may do each, and who may see it, is in
// `c33-authority.test.ts`, the records cases in `c33-versions.test.ts` and
// `c33-occurrences.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createRegistryWorld, detail, DIGEST, type RegistryWorld } from './registry-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C33 registry commands', () => {
  let w: RegistryWorld;

  beforeAll(async () => {
    w = await createRegistryWorld('c33c');
  }, 120_000);

  afterAll(async () => {
    await w?.controls.drop();
  });

  it('C33 owner check: each automation shows its mode and pinned version, and switching one to manual is recorded', async () => {
    const { definitionId, versionId } = await w.define(['manual', 'scheduled']);
    const on = await w.activate(versionId);
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const activationId = String(detail(on)['activationId']);

    const shown = (await w.registry(w.admin)).definitions.find((one) => one.id === definitionId);
    expect(shown?.name).toBe(`Weekly report ${w.canary}`);
    expect(shown?.versions.map((one) => [one.id, one.number, one.contentDigest])).toStrictEqual([
      [versionId, 1, DIGEST],
    ]);
    const before = shown?.activations.find((one) => one.id === activationId);
    expect([before?.mode, before?.versionId, before?.versionNumber, before?.enabled]).toStrictEqual(
      ['scheduled', versionId, 1, true],
    );

    const manual = await w.activate(versionId, {
      activationId,
      mode: 'manual',
      everyMinutes: null,
      expectedRevision: before?.revision,
    });
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    const after = (await w.registry(w.admin)).definitions
      .find((one) => one.id === definitionId)
      ?.activations.find((one) => one.id === activationId);
    expect([after?.mode, after?.changedBy, after?.revision]).toStrictEqual([
      'manual',
      w.admin.actorId,
      (before?.revision ?? 0) + 1,
    ]);
  });

  it('C33 definition.release: the next version of a definition is a new number, never an edit', async () => {
    const { definitionId, versionId } = await w.define(['manual']);
    const next = await w.release({ definitionId, modes: ['manual', 'event'] });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(detail(next)['number']).toBe(2);
    expect(detail(next)['versionId']).not.toBe(versionId);
    const shown = (await w.registry(w.admin)).definitions.find((one) => one.id === definitionId);
    expect(shown?.versions.map((one) => [one.number, one.modes])).toStrictEqual([
      [1, ['manual']],
      [2, ['manual', 'event']],
    ]);
    expect(shown?.versions.every((one) => one.releasedBy === w.admin.actorId)).toBe(true);
  });

  it('C33 definition.release refuses a malformed pin, mode list, name or kind, and writes nothing', async () => {
    const { definitionId } = await w.define(['manual']);
    const before = await w.changes();
    for (const [field, body] of [
      ['contentDigest', { definitionId, contentDigest: 'B'.repeat(64), modes: ['manual'] }],
      ['contentDigest', { definitionId, contentDigest: 'b'.repeat(63), modes: ['manual'] }],
      ['contentSize', { definitionId, contentSize: 0, modes: ['manual'] }],
      ['contentSize', { definitionId, contentSize: 1.5, modes: ['manual'] }],
      ['modes', { definitionId, modes: [] }],
      ['modes', { definitionId, modes: ['manual', 'manual'] }],
      ['modes', { definitionId, modes: ['hourly'] }],
      ['inputs', { definitionId, inputs: 'client', modes: ['manual'] }],
      ['operations', { definitionId, operations: [1], modes: ['manual'] }],
      ['name', { name: '', kind: 'automation', modes: ['manual'] }],
      ['name', { name: 'x\u0000y', kind: 'automation', modes: ['manual'] }],
      ['kind', { name: 'A name', kind: 'bootstrap', modes: ['manual'] }],
      ['name', { definitionId, name: 'renamed', modes: ['manual'] }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one malformed body at a time
      const answer = await w.release(body);
      expect([answer.status, answer.body['code'], answer.body['names']], field).toStrictEqual([
        400,
        'FIELD_VALUE_INVALID',
        [field],
      ]);
    }
    const unknown = await w.release({ definitionId: randomUUID(), modes: ['manual'] });
    expect([unknown.status, unknown.body['code']]).toStrictEqual([404, 'NOT_FOUND']);
    expect(await w.changes()).toStrictEqual(before);
  });

  it('C33 mode not permitted refused: activation.change naming a mode its version does not permit changes nothing', async () => {
    const { versionId } = await w.define(['manual']);
    const before = await w.changes();
    const scheduled = await w.activate(versionId);
    expect([scheduled.status, scheduled.body['code'], scheduled.body['names']]).toStrictEqual([
      409,
      'TRANSITION_NOT_PERMITTED',
      ['mode=scheduled'],
    ]);
    const on = await w.activate(versionId, { mode: 'manual', everyMinutes: null });
    expect(on.status).toBe(200);
    const activationId = String(detail(on)['activationId']);
    const mid = await w.changes();
    const event = await w.activate(versionId, {
      activationId,
      mode: 'event',
      everyMinutes: null,
      eventKind: 'invoice.paid',
      expectedRevision: 1,
    });
    expect([event.status, event.body['code']]).toStrictEqual([409, 'TRANSITION_NOT_PERMITTED']);
    expect(await w.changes()).toStrictEqual(mid);
    expect(mid).not.toStrictEqual(before);
  });

  it('C33 pinned version: an activation names one released version of its own definition, or is refused', async () => {
    const first = await w.define(['manual', 'scheduled']);
    const other = await w.define(['manual', 'scheduled'], 'Another automation');
    const on = await w.activate(first.versionId);
    const activationId = String(detail(on)['activationId']);
    const before = await w.changes();
    for (const [body, code] of [
      [{ versionId: randomUUID() }, 'NOT_FOUND'],
      [{ versionId: 'not-an-id' }, 'NOT_FOUND'],
      [
        { activationId, versionId: other.versionId, expectedRevision: 1 },
        'TRANSITION_NOT_PERMITTED',
      ],
      [{ activationId: randomUUID(), expectedRevision: 1 }, 'NOT_FOUND'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one pin at a time
      const answer = await w.activate(String(body.versionId ?? first.versionId), body);
      expect(answer.body['code'], JSON.stringify(body)).toBe(code);
    }
    expect(await w.changes()).toStrictEqual(before);
  });

  it('C33 activation.change refuses a malformed schedule, event kind, flag or revision, and a stale revision', async () => {
    const { versionId } = await w.define(['manual', 'scheduled', 'event']);
    const on = await w.activate(versionId);
    const activationId = String(detail(on)['activationId']);
    const before = await w.changes();
    for (const [field, body] of [
      ['mode', { mode: 'hourly' }],
      ['everyMinutes', { everyMinutes: 0 }],
      ['everyMinutes', { everyMinutes: 10_081 }],
      ['everyMinutes', { mode: 'manual', everyMinutes: 60 }],
      ['eventKind', { mode: 'event', everyMinutes: null, eventKind: 'Invoice Paid' }],
      ['eventKind', { mode: 'scheduled', eventKind: 'invoice.paid' }],
      ['enabled', { enabled: 'yes' }],
      ['expectedRevision', { activationId, expectedRevision: 0 }],
      ['expectedRevision', { activationId }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one malformed body at a time
      const answer = await w.activate(versionId, body);
      expect([answer.status, answer.body['code'], answer.body['names']], field).toStrictEqual([
        400,
        'FIELD_VALUE_INVALID',
        [field],
      ]);
    }
    const stale = await w.activate(versionId, { activationId, expectedRevision: 7 });
    expect([stale.status, stale.body['code']]).toStrictEqual([409, 'VERSION_STALE']);
    expect(await w.changes()).toStrictEqual(before);
  });

  it('C33 no run without approval: switching an activation to scheduled or event starts nothing by itself', async () => {
    const { versionId } = await w.define(['manual', 'scheduled', 'event']);
    const on = await w.activate(versionId, { mode: 'manual', everyMinutes: null });
    const activationId = String(detail(on)['activationId']);
    const occurrences = await w.rows('activation_occurrences');
    const scheduled = await w.activate(versionId, { activationId, expectedRevision: 1 });
    expect(scheduled.status).toBe(200);
    const event = await w.activate(versionId, {
      activationId,
      mode: 'event',
      everyMinutes: null,
      eventKind: 'invoice.paid',
      expectedRevision: 2,
    });
    expect(event.status).toBe(200);
    expect(await w.rows('activation_occurrences')).toBe(occurrences);
  });
});
