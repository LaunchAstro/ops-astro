// SPDX-License-Identifier: AGPL-3.0-only
//
// Installed system-write field keys at the top level of a request (root ruling 1).
//
// `SYSTEM_OWNED_FIELDS` names the envelope's own facts: actor, business,
// times, revision, source. The installed `field_defs` rows whose write mode is
// `system` name more -- `completed_at` and `key` on the task, and the comment's
// and state's own -- and those, sent at the top level, were accepted and
// dropped in silence (D06-GENERATED F1). The classifier now reads them from
// the installed metadata, so a field a preset installs as `system` is covered
// without a second list, and refuses them `FIELD_NOT_WRITABLE` by name.
//
// What it does not do: reject every unknown key, reject these names where a
// request legitimately nests them (a plan's field definitions carry `key`), or
// change `SOURCE_SPOOFED` for `source` inside `fields`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { SYSTEM_OWNED_FIELDS } from '../../packages/core-records/src/commands/prepare.ts';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { INSTALLED_SYSTEM_FIELDS } from '../acceptance/d06-cases.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The installed keys the envelope list did not already hold: the ones F1 found dropped. */
const NEWLY_REFUSED = INSTALLED_SYSTEM_FIELDS.filter((key) => !SYSTEM_OWNED_FIELDS.includes(key));

describe.skipIf(serverUrl === undefined)('installed system fields at the top level', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let token: string;
  let task: { id: string; revision: number };

  const call = async (name: CommandName, body: Record<string, unknown>): Promise<Answer> =>
    await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(token));

  const state = async () => {
    const rows = await fixture.db.admin.execute<Record<string, string>>(
      `select (select count(*)::text from public.records where business_id = $1) as records,
              (select coalesce(max(xmin::text::bigint), 0)::text from public.records where business_id = $1) as xmin,
              (select count(*)::text from public.audit_events where business_id = $1) as audit`,
      [fixture.business],
    );
    return rows[0] as Record<string, string>;
  };

  const lastAudit = async () => {
    const rows = await fixture.db.admin.execute<Record<string, unknown>>(
      `select command, outcome, refusal_code, attempted from public.audit_events
        where business_id = $1 order by seq desc limit 1`,
      [fixture.business],
    );
    return rows[0];
  };

  /** The task's revision as it is now, so an update's control is never stale. */
  const refresh = async () => {
    const rows = await fixture.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where business_id = $1 and id = $2`,
      [fixture.business, task.id],
    );
    task.revision = Number(rows[0]?.revision);
  };

  /** A fresh, valid body for each operation the cases use. */
  const bodies: Record<string, () => Record<string, unknown>> = {
    'task.create': () => ({ operationId: randomUUID(), fields: { title: 'a boundary task' } }),
    'task.update': () => ({
      operationId: randomUUID(),
      recordId: task.id,
      expectedRevision: task.revision,
      fields: { title: `retitled ${randomUUID()}` },
    }),
    'task.read': () => ({ recordId: task.id }),
    'task.board': () => ({ board: null }),
    'task.queue': () => ({}),
    'person.list': () => ({}),
    'session.capabilities': () => ({}),
  };

  beforeAll(async () => {
    fixture = await createApiFixture('boundary_fields');
    api = fixture.compose();
    token = await tokenFor(fixture.member.presented.subject);
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, fixture.member, 'read', WHOLE_BUSINESS, false, 'person');
      await grantTo(tx, fixture.member, 'manage', WHOLE_BUSINESS, false, 'task');
    });
    const made = await call('task.create', bodies['task.create']!());
    task = { id: String(made.body['recordId']), revision: Number(made.body['revision']) };
  }, 60_000);

  afterAll(async () => await fixture?.drop());

  it('takes the installed keys from field_defs, and they include completed_at and key', async () => {
    const rows = await fixture.db.admin.execute<{ readonly key: string }>(
      `select distinct key from public.field_defs
        where business_id = $1 and write_mode = 'system' and deactivated_at is null order by 1`,
      [fixture.business],
    );
    expect(rows.map((row) => row.key)).toStrictEqual([...INSTALLED_SYSTEM_FIELDS]);
    expect(NEWLY_REFUSED).toEqual(expect.arrayContaining(['completed_at', 'key']));
  });

  for (const name of Object.keys(bodies) as CommandName[]) {
    for (const key of NEWLY_REFUSED) {
      it(`${name} refuses top-level ${key} FIELD_NOT_WRITABLE and changes nothing`, async () => {
        await refresh();
        const control = await call(name, bodies[name]!());
        expect(control.status, JSON.stringify(control.body)).toBe(200);
        await refresh();

        const value = key.endsWith('_at') ? '1970-01-01T00:00:00.000Z' : `probe-${randomUUID()}`;
        const before = await state();
        const answer = await call(name, { ...bodies[name]!(), [key]: value });
        expect(answer.status).toBe(422);
        expect(answer.body).toMatchObject({
          refused: true,
          code: 'FIELD_NOT_WRITABLE',
          names: [key],
        });
        expect(JSON.stringify(answer.body)).not.toContain(value);
        const after = await state();
        expect(after['records']).toBe(before['records']);
        expect(after['xmin']).toBe(before['xmin']);
        expect(Number(after['audit'])).toBe(Number(before['audit']) + 1);
        expect(await lastAudit()).toStrictEqual({
          command: name,
          outcome: 'refused',
          refusal_code: 'FIELD_NOT_WRITABLE',
          attempted: { [key]: value },
        });
      });
    }
  }

  it('names every system key a body carries, installed and envelope alike, sorted', async () => {
    const answer = await call('task.create', {
      ...bodies['task.create']!(),
      key: 'T-1',
      completed_at: '1970-01-01T00:00:00.000Z',
      actor_id: randomUUID(),
    });
    expect(answer.body).toMatchObject({
      code: 'FIELD_NOT_WRITABLE',
      names: ['actor_id', 'completed_at', 'key'],
    });
  });

  it('keeps nesting: fields.completed_at is the field engine’s, fields.source stays SOURCE_SPOOFED', async () => {
    const derived = await call('task.create', {
      operationId: randomUUID(),
      fields: { title: 'nested', completed_at: '1970-01-01T00:00:00.000Z' },
    });
    expect(derived.body).toMatchObject({ code: 'FIELD_NOT_WRITABLE', names: ['completed_at'] });
    const spoofed = await call('task.create', {
      operationId: randomUUID(),
      fields: { title: 'nested', source: 'person:probe' },
    });
    expect(spoofed.body['code']).toBe('SOURCE_SPOOFED');
  });

  it('keeps a plan’s field definitions, which carry key by design', async () => {
    const answer = await call('preset.plan', {
      recordTypeKey: 'task',
      presetKey: 'boundary',
      fields: [{ key: 'boundary_note', label: 'Boundary note', valueType: 'text' }],
    });
    expect(answer.body['code']).not.toBe('FIELD_NOT_WRITABLE');
    expect(answer.body['code']).not.toBe('COMMAND_BODY_INVALID');
  });

  // The agent prefix classifies in `agent-envelope.ts`'s `parseOperands`,
  // which calls `claimedSystemFields`, so an installed system field is refused
  // on the agent route as on the person route.
  it('agent task.queue refuses top-level completed_at (agent route, handed back)', async () => {
    const answer = await post(
      api,
      `/api/a/b/${BUSINESS_KEY}${pathOf('task.queue')}`,
      { operationId: randomUUID(), completed_at: '1970-01-01T00:00:00.000Z' },
      authorised(await tokenFor(fixture.agent.subject)),
    );
    expect(answer.body).toMatchObject({ code: 'FIELD_NOT_WRITABLE', names: ['completed_at'] });
  });
});
