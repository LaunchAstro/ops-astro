// SPDX-License-Identifier: AGPL-3.0-only
//
// One world for C33's route cases (U36, #483): the API over a fresh database,
// a business with a holder of each key and each near miss, and a second
// business with its own definition, version and activation, released and
// switched on through the routes by its own administrator, whose definition
// name carries its own canary.
//
// Definitions carry no client, so the client crossing is a person holding
// every key at one real client's scope only: the registry and both changes are
// business-wide, and that holder is refused each of them and shown nothing.
//
// `wide` is the same boundary over a pool of its own connections, for a case
// whose two requests must hold transactions at once; the fixture's pool holds
// one, which would serialise them before they could race.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { expect } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { AutomationRegistryResult } from '../../packages/core-wire/src/index.ts';

export const DIGEST: string = 'b'.repeat(64);

export const RELEASE: Readonly<Record<string, unknown>> = {
  contentDigest: DIGEST,
  contentSize: 2048,
  inputs: [{ name: 'client', kind: 'id' }],
  operations: ['report.send'],
};

export const detail = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

type Body = Readonly<Record<string, unknown>>;

/** The ids of one automation: its definition, a version and an activation on it. */
export interface Automation {
  readonly definitionId: string;
  readonly versionId: string;
  readonly activationId: string;
}

export interface RegistryWorld {
  readonly controls: Controls;
  readonly alpha: string;
  readonly bravo: string;
  readonly canary: string;
  readonly bravoCanary: string;
  /** Every answer any case got, for the canary sweep. */
  readonly answers: Answer[];
  readonly admin: Member;
  readonly settingsOnly: Member;
  readonly automationOnly: Member;
  readonly reader: Member;
  /** Every key, at one real client's scope only. */
  readonly clientManager: Member;
  readonly plain: Member;
  readonly bravoAdmin: Member;
  /** Bravo's own automation, released and switched on through the routes. */
  readonly bravoRows: Automation;
  as(who: Member, name: string, body: Body, business?: string): Promise<Answer>;
  /** The same call through the wide boundary, which holds its own connections; `bearer` signs in as one session. */
  asWide(who: Member, name: string, body: Body, bearer?: string): Promise<Answer>;
  /** As `asWide`, through an API over `wrap` of a pool of its own (a case's stop between statements). */
  asThrough(
    wrap: (inner: Database) => Database,
    who: Member,
    name: string,
    body: Body,
    bearer?: string,
  ): Promise<Answer>;
  registry(who: Member, business?: string): Promise<AutomationRegistryResult>;
  release(body: Body, who?: Member, business?: string): Promise<Answer>;
  /** A new definition with one version in `modes`; answers its ids. */
  define(
    modes: readonly string[],
    name?: string,
    who?: Member,
    business?: string,
  ): Promise<{ readonly definitionId: string; readonly versionId: string }>;
  /** A scheduled, enabled activation by default; `body` overrides. */
  activate(versionId: string, body?: Body, who?: Member, business?: string): Promise<Answer>;
  rows(table: string, business?: string): Promise<number>;
  /** One business's definitions, versions, activations, their revisions summed, and occurrences. */
  changes(business?: string): Promise<readonly number[]>;
  /** A connection of the owner's own, for a case that holds a row while two requests race. */
  holderUrl(): string;
  drop(): Promise<void>;
}

/** Bravo's administrator releases a definition and switches an activation on, as alpha's would. */
async function bravoAutomation(
  as: RegistryWorld['as'],
  bravoAdmin: Member,
  name: string,
): Promise<Automation> {
  const released = await as(
    bravoAdmin,
    'definition.release',
    { ...RELEASE, name, kind: 'automation', modes: ['manual', 'scheduled'] },
    'bravo',
  );
  expect(released.status, JSON.stringify(released.body)).toBe(200);
  const versionId = String(detail(released)['versionId']);
  const on = await as(
    bravoAdmin,
    'activation.change',
    { versionId, mode: 'scheduled', everyMinutes: 30, enabled: true },
    'bravo',
  );
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  return {
    definitionId: String(detail(released)['definitionId']),
    versionId,
    activationId: String(detail(on)['activationId']),
  };
}

// eslint-disable-next-line max-lines-per-function -- the world and its helpers, built in one place
export async function createRegistryWorld(part: string): Promise<RegistryWorld> {
  const controls = await createControls(part);
  const { db, business } = controls.fixture;
  const canary = `c33-canary-${randomUUID()}`;
  const bravoCanary = `c33-bravo-${randomUUID()}`;
  const answers: Answer[] = [];
  const admin = controls.manager;
  const settingsOnly = await enrol(db.app, business, 'settingsonly');
  const automationOnly = await enrol(db.app, business, 'automationonly');
  const reader = await enrol(db.app, business, 'reader');
  const clientManager = await enrol(db.app, business, 'clientmanager');
  const plain = await enrol(db.app, business, 'plain');
  const clientId = randomUUID();
  await db.admin.execute(
    `insert into public.clients (business_id, id, name, created_by_actor_id)
     values ($1, $2, 'A real client', $3)`,
    [business, clientId, admin.actorId],
  );
  const whole = { kind: 'business', id: null } as const;
  const client = { kind: 'party', id: clientId } as const;
  await db.app.withBusiness(business, async (tx) => {
    for (const [who, action, scope, collection] of [
      [admin, 'manage', whole, 'settings'],
      [admin, 'read', whole, 'settings'],
      [admin, 'manage', whole, 'automation'],
      [settingsOnly, 'manage', whole, 'settings'],
      [settingsOnly, 'read', whole, 'settings'],
      [automationOnly, 'manage', whole, 'automation'],
      [automationOnly, 'read', whole, 'settings'],
      [reader, 'read', whole, 'settings'],
      [reader, 'write', whole, 'settings'],
      [clientManager, 'manage', client, 'settings'],
      [clientManager, 'read', client, 'settings'],
      [clientManager, 'manage', client, 'automation'],
      [plain, 'read', whole, 'task'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- `issueGrant` reads the granter's own rows
      await grantTo(tx, who, action, scope, false, collection);
    }
  });

  const bravo = await insertBusiness(db.app, 'bravo');
  await installSpine(db.app, bravo);
  const bravoAdmin = await enrol(db.app, bravo, 'bravoadmin');
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoAdmin, 'manage', whole, false, 'settings');
    await grantTo(tx, bravoAdmin, 'read', whole, false, 'settings');
    await grantTo(tx, bravoAdmin, 'manage', whole, false, 'automation');
  });

  let wide: { readonly pool: Database; readonly api: Hono } | undefined;
  const send = async (
    api: Hono,
    who: Member,
    at: string,
    name: string,
    body: Body,
    bearer?: string,
  ) => {
    const answer = await post(
      api,
      path(at, name),
      { operationId: randomUUID(), ...body },
      authorised(bearer ?? (await tokenFor(who.presented.subject))),
    );
    answers.push(answer);
    return answer;
  };
  const as = async (who: Member, name: string, body: Body, at = 'alpha'): Promise<Answer> =>
    await send(controls.api, who, at, name, body);
  const release = async (body: Body, who = admin, at = 'alpha'): Promise<Answer> =>
    await as(who, 'definition.release', { ...RELEASE, ...body }, at);
  const businessOf = (at: string): string => (at === 'bravo' ? bravo : business);
  const rows = async (table: string, at = 'alpha'): Promise<number> =>
    await controls.count(`select count(*) as n from public.${table} where business_id = $1`, [
      businessOf(at),
    ]);
  const bravoRows = await bravoAutomation(as, bravoAdmin, `Bravo digest ${bravoCanary}`);

  return {
    controls,
    alpha: business,
    bravo,
    canary,
    bravoCanary,
    answers,
    admin,
    settingsOnly,
    automationOnly,
    reader,
    clientManager,
    plain,
    bravoAdmin,
    bravoRows,
    as,
    async asWide(who, name, body, bearer) {
      wide ??= (() => {
        const pool = connect(db.appUrl, { source: 'runtime', max: 4 });
        return { pool, api: controls.fixture.compose(undefined, undefined, pool) };
      })();
      return await send(wide.api, who, 'alpha', name, body, bearer);
    },
    async asThrough(wrap, who, name, body, bearer) {
      const pool = wrap(connect(db.appUrl, { source: 'runtime', max: 2 }));
      try {
        const api = controls.fixture.compose(undefined, undefined, pool);
        return await send(api, who, 'alpha', name, body, bearer);
      } finally {
        await pool.close();
      }
    },
    release,
    rows,
    async registry(who, at = 'alpha') {
      const answer = await as(who, 'automation.registry', {}, at);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return answer.body as unknown as AutomationRegistryResult;
    },
    async define(modes, name = `Weekly report ${canary}`, who = admin, at = 'alpha') {
      const answer = await release({ name, kind: 'automation', modes }, who, at);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return {
        definitionId: String(detail(answer)['definitionId']),
        versionId: String(detail(answer)['versionId']),
      };
    },
    async activate(versionId, body = {}, who = admin, at = 'alpha') {
      return await as(
        who,
        'activation.change',
        { versionId, mode: 'scheduled', everyMinutes: 60, enabled: true, ...body },
        at,
      );
    },
    async changes(at = 'alpha') {
      return [
        await rows('automation_definitions', at),
        await rows('definition_versions', at),
        await rows('activations', at),
        await controls.count(
          'select coalesce(sum(revision), 0) as n from public.activations where business_id = $1',
          [businessOf(at)],
        ),
        await rows('activation_occurrences', at),
      ];
    },
    holderUrl() {
      const url = new URL(String(databaseUrlFromEnvironment()));
      url.pathname = `/${db.name}`;
      return url.toString();
    },
    async drop() {
      await wide?.pool.close();
      await controls.drop();
    },
  };
}
