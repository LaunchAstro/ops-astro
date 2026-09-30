// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the preference store's suites share (MP-2-11a, MP-2-11): one
// business with its controls, Ada and Ben enrolled with a live read grant each,
// and Ada's stored canary. The bindings are live, so a suite that calls
// `usePreferencesWorld()` reads them once its `beforeAll` has run.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import type { Hono } from 'hono';
import { pathOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';

export type Preferences = Readonly<Record<string, unknown>>;

/** Stored on Ada's row and looked for in every other caller's answer. */
export const CANARY: string = `canary-${randomUUID()}`;

export let c: Controls;
export let fixture: ApiFixture;
let api: Hono;
export let ada: Member;
export let adaToken = '';
export let ben: Member;
export let benToken = '';

export const call = async (
  name: string,
  body: Readonly<Record<string, unknown>>,
  token: string,
  options: { readonly key?: string; readonly agent?: boolean } = {},
): Promise<Answer> =>
  await post(
    api,
    `/api${options.agent === true ? '/a' : ''}/b/${options.key ?? BUSINESS_KEY}${pathOf(name as CommandName)}`,
    body,
    authorised(token),
  );

export const save = async (
  key: string,
  value: unknown,
  token: string,
  extra = {},
): Promise<Answer> =>
  await call(
    'preference.save',
    { operationId: randomUUID(), preference: key, value, ...extra },
    token,
  );

export const read = async (token: string, key?: string): Promise<Preferences> => {
  const answer = await call('preference.read', {}, token, key === undefined ? {} : { key });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body['preferences'] as Preferences;
};

export const rowsOf = async (
  personId: string,
): Promise<readonly { key: string; value: unknown }[]> =>
  (
    await fixture.db.admin.execute<{ key: string; value: unknown }>(
      `select key, value from public.person_preferences where person_id = $1 order by key`,
      [personId],
    )
  ).map((row) => ({ key: row.key, value: row.value }));

export const auditCount = async (actorId: string): Promise<number> => {
  const [row] = await fixture.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.audit_events
      where actor_id = $1 and command = 'preference.save'`,
    [actorId],
  );
  return Number(row?.n);
};

/** One tip dismissed through the command, as `token`'s caller. */
export const dismiss = async (
  tip: Readonly<Record<string, unknown>>,
  token: string,
  options: { readonly key?: string } = {},
): Promise<Answer> =>
  await call('preference.dismiss_tip', { operationId: randomUUID(), ...tip }, token, options);

/** Audit events of `preference.dismiss_tip` under `actorId`. */
export const dismissals = async (actorId: string): Promise<number> => {
  const [row] = await fixture.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.audit_events
      where actor_id = $1 and command = 'preference.dismiss_tip'`,
    [actorId],
  );
  return Number(row?.n);
};

/** The caller's `tips.dismissed`, read back. */
export const dismissedOf = async (token: string): Promise<unknown> =>
  (await read(token))['tips.dismissed'];

/** Nobody's answer but Ada's ever carries her stored canary. */
export const expectNoCanary = (answer: Answer): void => {
  expect(JSON.stringify(answer.body)).not.toContain(CANARY);
};

/** Registers the world's setup and teardown in the calling suite. */
export function usePreferencesWorld(prefix: string): void {
  beforeAll(async () => {
    c = await createControls(prefix);
    fixture = c.fixture;
    api = c.api;
    ada = await enrol(fixture.db.app, fixture.business, 'Ada Pref');
    ben = await enrol(fixture.db.app, fixture.business, 'Ben Pref');
    // A live grant each: `preference.read`, like the inbox reads, refuses a
    // caller holding none. The save asks no grant.
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, ada, 'read');
      await grantTo(tx, ben, 'read');
    });
    adaToken = await tokenFor(ada.presented.subject);
    benToken = await tokenFor(ben.presented.subject);
    const canary = await save('columns.widths', { [CANARY]: 111 }, adaToken);
    expect(canary.status, JSON.stringify(canary.body)).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });
}
