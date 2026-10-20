// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the taken-launch suites (#2178): one served API whose member is
// the business's owner and owns its agent, his plan on his own task approved
// and handed to that agent, and his Launch of it taken by the agent, which
// hands the worker's credential back.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { expect } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { bindPartySite } from '../../packages/core-records/src/site/party-sites.ts';
import { DELEGATION_HEADER, pathOf } from '../../packages/core-wire/src/surface.ts';
import { SYNTHETIC_STEP } from '../../apps/worker/worker.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';

/** A 200's detail, or the case fails with the refusal it got. */
export const applied = (answer: Answer): Record<string, unknown> => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return (answer.body['detail'] as Record<string, unknown> | undefined) ?? answer.body;
};

export interface OwnerLaunchWorld {
  readonly fixture: ApiFixture;
  /** A command by the owner, on the person path. */
  as(name: string, body: object): Promise<Answer>;
  /** A command by his agent's own login, under `credential` when one is given. */
  asAgent(name: string, body: object, credential?: string): Promise<Answer>;
  revisionOf(taskId: string): Promise<number>;
  /** His own task, his step proposed and approved, then handed to his agent. */
  ownersPlan(title: string): Promise<string>;
  /** His Launch of the task, taken by his agent: the credential the worker is handed. */
  takenLaunch(taskId: string): Promise<string>;
  /** The reservation the agent's queue offers for his plan on `taskId`. */
  reservationOn(taskId: string): Promise<unknown>;
  /** A fresh page on the business's own site, with the owner named its corrections' approver. */
  ownSitePage(): Promise<string>;
  /** What any write would leave in the business. */
  footprint(): Promise<Record<string, number> | undefined>;
}

// oxlint-disable-next-line max-lines-per-function -- one world's helpers over one served API
export async function ownerLaunchWorld(part: string): Promise<OwnerLaunchWorld> {
  const fixture: ApiFixture = await createApiFixture(part);
  const api: Hono = fixture.compose();
  await fixture.db.admin.execute(
    `update public.memberships set active = false, ended_at = clock_timestamp()
      where business_id = $1 and person_id = $2 and active`,
    [fixture.business, fixture.member.personId],
  );
  await fixture.db.admin.execute(
    `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
     values ($1, $2, $3, 'owner', true, clock_timestamp())`,
    [fixture.business, randomUUID(), fixture.member.personId],
  );
  // His own agent: only an agent he owns may be handed his task.
  await fixture.db.admin.execute(
    'update public.actors set owner_person_id = $2 where business_id = $1 and id = $3',
    [fixture.business, fixture.member.personId, fixture.agentActorId],
  );
  await fixture.db.admin.execute(
    'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
    [fixture.business],
  );
  // An owner writes runs, so the pickup on his plan carries `run` (`pickup.ts`
  // `delegatedCollections`), which the worker's correction needs.
  await fixture.db.app.withBusiness(
    fixture.business,
    async (tx) => await grantTo(tx, fixture.member, 'write', undefined, false, 'run'),
  );
  const ownerToken = await tokenFor(fixture.member.presented.subject);
  const agentToken = await tokenFor(fixture.agent.subject);

  const as = async (name: string, body: object): Promise<Answer> =>
    await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name as never)}`, body, authorised(ownerToken));

  const asAgent = async (name: string, body: object, credential?: string): Promise<Answer> =>
    await post(api, `/api/a/b/${BUSINESS_KEY}${pathOf(name as never)}`, body, {
      ...authorised(agentToken),
      ...(credential === undefined ? {} : { [DELEGATION_HEADER]: credential }),
    });

  const revisionOf = async (taskId: string): Promise<number> => {
    const rows = await fixture.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [taskId],
    );
    return Number(rows[0]?.revision ?? '0');
  };

  const ownersPlan = async (title: string): Promise<string> => {
    const created = await as('task.create', { operationId: randomUUID(), fields: { title } });
    applied(created);
    const taskId = String(created.body['recordId']);
    const proposed = applied(
      await as('task.propose', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: await revisionOf(taskId),
        purpose: SYNTHETIC_STEP.kind,
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: {},
        step: SYNTHETIC_STEP,
      }),
    );
    applied(
      await as('task.decide', {
        operationId: randomUUID(),
        gateId: proposed['gateId'],
        versionId: proposed['versionId'],
        decision: 'approve',
        note: 'go ahead',
      }),
    );
    applied(
      await as('task.assign', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: await revisionOf(taskId),
        fields: { agent: fixture.agentActorId },
      }),
    );
    return taskId;
  };

  const takenLaunch = async (taskId: string): Promise<string> => {
    applied(
      await as('task.launch', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: await revisionOf(taskId),
      }),
    );
    const [launch] = await fixture.db.admin.execute<{ readonly id: string }>(
      `select id from public.task_launches where task_id = $1 and state = 'waiting'`,
      [taskId],
    );
    const taken = applied(
      await asAgent('task.take_launch', { operationId: randomUUID(), launchId: launch?.id }),
    );
    expect(taken['state']).toBe('started');
    return String(taken['credential']);
  };

  const reservationOn = async (taskId: string): Promise<unknown> => {
    const queue = applied(await asAgent('task.queue', { operationId: randomUUID() }));
    const entries = (queue['queue'] ?? []) as readonly Record<string, unknown>[];
    return entries.find((entry) => entry['taskId'] === taskId && entry['ownerProposed'] === true)?.[
      'reservationId'
    ];
  };

  const footprint = async () =>
    (
      await fixture.db.admin.execute<Record<string, number>>(
        `select (select count(*)::int from public.records where business_id = $1) as records,
              (select coalesce(sum(revision), 0)::int from public.records where business_id = $1) as revisions,
              (select count(*)::int from public.delegations where business_id = $1) as delegations,
              (select count(*)::int from public.proposal_lineages where business_id = $1) as lineages,
              (select count(*)::int from public.leases where business_id = $1) as leases`,
        [fixture.business],
      )
    )[0];

  const ownSitePage = async (): Promise<string> => {
    const name = randomUUID().slice(0, 8);
    const page = `https://own-${name}.example/about`;
    // The named settings, as the local seed installs them, so the approver has a row.
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await installBusinessSettings(tx);
      await grantTo(tx, fixture.member, 'manage', undefined, false, 'settings');
      await grantTo(tx, fixture.member, 'decide', undefined, false, 'gate');
      await bindPartySite(
        tx,
        {
          partyId: null,
          repository: `own/site-${name}`,
          defaultBranch: 'main',
          project: `prj_own_${name}`,
          pages: [{ pageUrl: page, path: 'src/pages/about.md' }],
        },
        fixture.member.actorId,
      );
    });
    applied(
      await as('settings.set_live_correction_approver', {
        operationId: randomUUID(),
        value: fixture.member.personId,
      }),
    );
    return page;
  };
  return {
    fixture,
    as,
    asAgent,
    revisionOf,
    ownersPlan,
    takenLaunch,
    reservationOn,
    ownSitePage,
    footprint,
  };
}
