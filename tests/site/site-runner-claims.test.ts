// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's claims through the real queue (#1692): a person's
// `site_publish` step, approved, is picked up as the runner's agent actor, its
// task's correction published under that lease, the lease renewed while the
// publish is followed and handed back once settled. Work with another purpose
// stays on the queue. Every provider is a double.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { queueClaims, SITE_PURPOSE, type AgentCall } from '../../apps/site-runner/claims.ts';
import { createSiteRunner } from '../../apps/site-runner/runner.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { serverUrl, w } from './c80-register-world.ts';
import {
  building,
  built,
  merges,
  time,
  useRunnerWorld,
  world,
  type World,
} from './site-runner-world.ts';

useRunnerWorld();

const call: AgentCall = async (verb, body, pickup) => {
  const result = await w.world.asAgent(
    { command: verb, operationId: randomUUID(), ...body },
    pickup,
  );
  return isCommandRefusal(result) ? { refused: result.code } : { detail: result.detail };
};

const need = (result: Awaited<ReturnType<typeof w.as>>): Readonly<Record<string, unknown>> => {
  if (isCommandRefusal(result)) throw new Error(`refused ${result.code}`);
  return { ...result.detail, recordId: result.recordId, revision: result.revision };
};

/** A task under party A with an approved correction and an approved step of `purpose` on the queue. */
async function queued(purpose: string): Promise<{ taskId: string; correctionId: string }> {
  const created = need(await w.as(w.cal, { command: 'task.create', fields: { title: 'About' } }));
  const taskId = String(created['recordId']);
  const set = need(
    await w.as(w.admin, {
      command: 'task.set_party',
      recordId: taskId,
      expectedRevision: created['revision'],
      fields: { client: w.partyA },
    }),
  );
  const proposed = need(
    await w.as(w.cal, {
      command: 'task.propose',
      recordId: taskId,
      expectedRevision: set['revision'],
      purpose,
      maximumMinor: 1,
      currency: 'AUD',
      payload: { instruction: 'publish the approved correction' },
      step: { kind: 'compose', payload: {} },
    }),
  );
  need(
    await w.as(w.cal, {
      command: 'task.decide',
      gateId: proposed['gateId'],
      versionId: proposed['versionId'],
      decision: 'approve',
      note: 'Launch',
    }),
  );
  const detail = detailOf(await w.request(w.ava, { taskId }));
  const correctionId = String(detail['correctionId']);
  need(await w.approve(w.ben, correctionId, String(detail['versionId'])));
  return { taskId, correctionId };
}

function runnerFor(given: World) {
  return createSiteRunner({
    db: w.world.db.app,
    business: w.world.business,
    actorId: w.world.agentActorId,
    claims: queueClaims(call, w.world.db.app, w.world.business),
    sites: given.sites,
    raiseTask: (_claim, reason) => {
      given.raised.push(reason);
      return Promise.resolve();
    },
    now: () => time.clock,
  });
}

async function leaseOf(taskId: string): Promise<{ state: string; expires: string } | undefined> {
  const [row] = await w.world.db.admin.execute<{ state: string; expires: string }>(
    `select state, expires_at::text as expires from public.leases
      where task_id = $1 order by fence desc limit 1`,
    [taskId],
  );
  return row;
}

describe.skipIf(serverUrl === undefined)('the site runner, claiming through the queue', () => {
  it('picks up queued site work, publishes its correction and hands the lease back', async () => {
    const { taskId, correctionId } = await queued(SITE_PURPOSE);
    const given = world();
    const runner = runnerFor(given);

    expect(await runner.pass()).toEqual([{ correctionId, outcome: 'live' }]);
    expect(merges(given.site)).toHaveLength(1);
    expect((await leaseOf(taskId))?.state).not.toBe('live');
    expect(await runner.pass()).toEqual([]);
  });

  it('renews the lease while it follows a building deployment', async () => {
    const { taskId, correctionId } = await queued(SITE_PURPOSE);
    const given = world();
    building(given.site);
    const runner = runnerFor(given);

    expect(await runner.pass()).toEqual([{ correctionId, outcome: 'following' }]);
    const first = await leaseOf(taskId);
    time.clock += 15_000;
    expect(await runner.pass()).toEqual([{ correctionId, outcome: 'following' }]);
    expect((await leaseOf(taskId))?.state).toBe('live');
    expect(Date.parse(String((await leaseOf(taskId))?.expires))).toBeGreaterThanOrEqual(
      Date.parse(String(first?.expires)),
    );
    built(given.site);
    expect(await runner.pass()).toEqual([{ correctionId, outcome: 'live' }]);
    expect(merges(given.site)).toHaveLength(1);
  });

  it('leaves work with another purpose on the queue', async () => {
    const { taskId } = await queued(`draft_${randomUUID().slice(0, 8)}`);
    const given = world();

    expect(await runnerFor(given).pass()).toEqual([]);
    expect(merges(given.site)).toHaveLength(0);
    expect(await leaseOf(taskId)).toBeUndefined();
  });
});
