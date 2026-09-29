// SPDX-License-Identifier: AGPL-3.0-only
//
// One world for C33's route cases (U36, #483): the API over a fresh database,
// a business with a holder of each key and each near miss, and a second
// business whose one definition name carries its own canary.
//
// Definitions carry no client, so the client crossing is a person holding
// every key at one client's scope only: the registry and both changes are
// business-wide, and that holder is refused each of them and shown nothing.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import type { AutomationRegistryResult } from '../../packages/core-wire/src/index.ts';

export const DIGEST: string = 'b'.repeat(64);

export const RELEASE: Readonly<Record<string, unknown>> = {
  contentDigest: DIGEST,
  contentSize: 2048,
  inputs: [{ name: 'client', kind: 'id' }],
  operations: ['report.send'],
};

export const detail = (answer: Answer): Record<string, unknown> =>
  answer.body['detail'] as Record<string, unknown>;

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

type Body = Readonly<Record<string, unknown>>;

export interface RegistryWorld {
  readonly controls: Controls;
  readonly canary: string;
  readonly bravoCanary: string;
  /** Every answer any case got, for the canary sweep. */
  readonly answers: Answer[];
  readonly admin: Member;
  readonly settingsOnly: Member;
  readonly automationOnly: Member;
  readonly reader: Member;
  readonly clientManager: Member;
  readonly plain: Member;
  readonly bravoAdmin: Member;
  as(who: Member, name: string, body: Body, business?: string): Promise<Answer>;
  registry(who: Member, business?: string): Promise<AutomationRegistryResult>;
  release(body: Body, who?: Member, business?: string): Promise<Answer>;
  /** A new definition with one version in `modes`; answers its ids. */
  define(
    modes: readonly string[],
    name?: string,
  ): Promise<{ readonly definitionId: string; readonly versionId: string }>;
  /** A scheduled, enabled activation by default; `body` overrides. */
  activate(versionId: string, body?: Body, who?: Member): Promise<Answer>;
  rows(table: string): Promise<number>;
  /** Definitions, versions, activations, their revisions summed, and occurrences. */
  changes(): Promise<readonly number[]>;
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
  const whole = { kind: 'business', id: null } as const;
  const partyA = { kind: 'party', id: randomUUID() } as const;
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, admin, 'manage', whole, false, 'settings');
    await grantTo(tx, admin, 'read', whole, false, 'settings');
    await grantTo(tx, admin, 'manage', whole, false, 'automation');
    await grantTo(tx, settingsOnly, 'manage', whole, false, 'settings');
    await grantTo(tx, settingsOnly, 'read', whole, false, 'settings');
    await grantTo(tx, automationOnly, 'manage', whole, false, 'automation');
    await grantTo(tx, automationOnly, 'read', whole, false, 'settings');
    await grantTo(tx, reader, 'read', whole, false, 'settings');
    await grantTo(tx, reader, 'write', whole, false, 'settings');
    await grantTo(tx, clientManager, 'manage', partyA, false, 'settings');
    await grantTo(tx, clientManager, 'read', partyA, false, 'settings');
    await grantTo(tx, clientManager, 'manage', partyA, false, 'automation');
    await grantTo(tx, plain, 'read', whole, false, 'task');
  });

  const bravo = await insertBusiness(db.app, 'bravo');
  await installSpine(db.app, bravo);
  const bravoAdmin = await enrol(db.app, bravo, 'bravoadmin');
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoAdmin, 'manage', whole, false, 'settings');
    await grantTo(tx, bravoAdmin, 'read', whole, false, 'settings');
    await grantTo(tx, bravoAdmin, 'manage', whole, false, 'automation');
  });
  // Owner-written, so every case stands on its own command.
  await db.admin.execute(
    `insert into public.automation_definitions (business_id, id, kind, name, created_by_actor_id)
     values ($1, $2, 'automation', $3, $4)`,
    [bravo, randomUUID(), `Bravo digest ${bravoCanary}`, bravoAdmin.actorId],
  );

  const as = async (who: Member, name: string, body: Body, at = 'alpha'): Promise<Answer> => {
    const answer = await post(
      controls.api,
      path(at, name),
      { operationId: randomUUID(), ...body },
      authorised(await tokenFor(who.presented.subject)),
    );
    answers.push(answer);
    return answer;
  };
  const release = async (body: Body, who = admin, at = 'alpha'): Promise<Answer> =>
    await as(who, 'definition.release', { ...RELEASE, ...body }, at);
  const rows = async (table: string): Promise<number> =>
    await controls.count(`select count(*) as n from public.${table}`, []);

  return {
    controls,
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
    as,
    release,
    rows,
    async registry(who, at = 'alpha') {
      const answer = await as(who, 'automation.registry', {}, at);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return answer.body as unknown as AutomationRegistryResult;
    },
    async define(modes, name = `Weekly report ${canary}`) {
      const answer = await release({ name, kind: 'automation', modes });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return {
        definitionId: String(detail(answer)['definitionId']),
        versionId: String(detail(answer)['versionId']),
      };
    },
    async activate(versionId, body = {}, who = admin) {
      return await as(who, 'activation.change', {
        versionId,
        mode: 'scheduled',
        everyMinutes: 60,
        enabled: true,
        ...body,
      });
    },
    async changes() {
      return [
        await rows('automation_definitions'),
        await rows('definition_versions'),
        await rows('activations'),
        await controls.count('select coalesce(sum(revision), 0) as n from public.activations', []),
        await rows('activation_occurrences'),
      ];
    },
  };
}
