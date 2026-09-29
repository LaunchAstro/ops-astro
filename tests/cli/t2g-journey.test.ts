// SPDX-License-Identifier: AGPL-3.0-only
//
// T2g's invariant, `journey_parity_cli` (split 1.2, T2-R9; product issue 17).
// The whole journey runs twice against the real served API: once with every
// person's step through the command line as its own process, once through the
// person's HTTP route the app posts to. The worker proposes and applies under
// its own login and delegation both times. Each leg records the same facts,
// the receipt read and the run's events included, and refuses the same things:
//
// - the task's assignee may not decide its gate (`FOUR_EYES_REQUIRED`);
// - the task may not be completed while its gate is open (`GATE_PENDING`);
// - a decided gate is not decided twice (`GATE_ALREADY_DECIDED`);
// - an agent presenting its delegation is refused the decision, the refusal's
//   audit event names that exact delegation, and no decision is written.
//
// Red until a worker can finish the journey; red if the command line is
// refused anything the app route allows, because the facts are compared whole.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { httpTransport } from '../../apps/cli/client.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { runCli, serveApi, type ServedApi } from './cli-process-harness.ts';

type Leg = 'cli' | 'app';
type Name = Parameters<typeof pathOf>[0];

interface Answer {
  readonly ok: boolean;
  readonly code: string | null;
  readonly body: Record<string, unknown>;
}

const detail = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] ?? {}) as Record<string, unknown>;

describe.skipIf(serverUrl === undefined)('T2g journey_parity_cli', () => {
  let world: World;
  let api: ServedApi | undefined;
  let scratch: string;

  const env = (token: string, extra: Readonly<Record<string, string>> = {}) => ({
    OPS_ASTRO_API_URL: (api as ServedApi).origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: token,
    OPS_ASTRO_TOKEN_FILE: join(scratch, `token-${randomUUID()}`),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, `delegation-${randomUUID()}`),
    ...extra,
  });

  /** One person's step on one leg. */
  async function step(leg: Leg, name: Name, body: object, token: string): Promise<Answer> {
    if (leg === 'cli') {
      const run = await runCli([name, '--json', JSON.stringify(body)], env(token));
      const json = (run.json ?? {}) as Record<string, unknown>;
      return {
        ok: run.code === 0,
        code: typeof json['code'] === 'string' ? json['code'] : null,
        body: json,
      };
    }
    const response = await fetch(`${(api as ServedApi).origin}/api/b/alpha${pathOf(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ operationId: randomUUID(), ...body }),
    });
    const json = (await response.json()) as Record<string, unknown>;
    return {
      ok: response.ok,
      code: typeof json['code'] === 'string' ? json['code'] : null,
      body: json,
    };
  }

  async function journey(leg: Leg) {
    const ada = world.ada.token;
    const mia = world.mia.token;
    const created = await step(leg, 'task.create', { fields: { title: `t2g ${leg}` } }, ada);
    const taskId = String(created.body['recordId']);
    const assigned = await step(
      leg,
      'task.assign',
      {
        recordId: taskId,
        expectedRevision: created.body['revision'],
        fields: { assignee: world.ada.personId },
      },
      ada,
    );

    const delegation = await world.db.app.withBusiness(world.alpha, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: world.agent.actorId,
        delegatePersonId: world.ada.personId as string,
        mintedByActorId: world.ada.actorId as string,
        purpose: `t2g_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        purposeScope: { kind: 'record', id: taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
      return minted.value;
    });
    const worker = createWorker({
      transport: httpTransport((api as ServedApi).origin),
      businessKey: 'alpha',
      credential: world.agent.token,
      delegation: delegation.credential,
      reporter: SYNTHETIC_USAGE,
    });
    const proposed = await worker.proposeOnce();
    if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
    const gateId = proposed.proposed.gateId;
    const read = await step(leg, 'task.read', { recordId: taskId }, ada);
    const task = read.body['task'] as { proposals: { versions: { versionId: string }[] }[] };
    const versionId = String(task.proposals[0]?.versions[0]?.versionId);
    const decide = (decision: string) => ({ gateId, versionId, decision, note: `t2g ${leg}` });

    // The agent, under the delegation it proposed with, asks to decide.
    const agentRun = await runCli(
      ['task.decide', '--json', JSON.stringify(decide('approve'))],
      env(world.agent.token, { OPS_ASTRO_AGENT: '1', OPS_ASTRO_DELEGATION: delegation.credential }),
    );
    const agentAudit = await world.db.admin.execute<{ readonly attempted: unknown }>(
      `select attempted from public.audit_events
        where business_id = $1 and actor_id = $2 and command = 'task.decide'
        order by seq desc limit 1`,
      [world.alpha, world.agent.actorId],
    );

    const byAssignee = await step(leg, 'task.decide', decide('approve'), ada);
    const whileOpen = await step(
      leg,
      'task.complete',
      { recordId: taskId, expectedRevision: assigned.body['revision'] },
      ada,
    );
    const approved = await step(leg, 'task.decide', decide('approve'), mia);
    const twice = await step(leg, 'task.decide', decide('approve'), mia);

    const applied = await worker.applyOnce(taskId);
    if (!('applied' in applied)) throw new Error(`apply: ${JSON.stringify(applied)}`);
    const receipt = await step(leg, 'task.receipt', { attemptId: applied.applied.attemptId }, mia);
    const execution = await step(leg, 'task.execution', { recordId: taskId }, mia);
    const decisions = await world.db.admin.execute<{
      readonly decision: string;
      readonly person: string;
      readonly actor: string;
    }>(
      `select decision, decided_by_person_id as person, decided_by_actor_id as actor
         from public.gate_decisions where business_id = $1 and gate_id = $2 order by seq`,
      [world.alpha, gateId],
    );
    await world.db.admin.execute(
      `update public.delegations set revoked_at = now(), revocation_cause = 'work_retired'
        where business_id = $1 and agent_actor_id = $2 and revoked_at is null and settled_at is null`,
      [world.alpha, world.agent.actorId],
    );

    const receiptBody = (receipt.body['receipt'] ?? {}) as Record<string, unknown>;
    const events = (execution.body['events'] ?? []) as { kind: string }[];
    return {
      facts: {
        agent: { ok: agentRun.code === 0, attempted: agentAudit[0]?.attempted },
        byAssignee: byAssignee.code,
        whileOpen: whileOpen.code,
        approved: approved.ok,
        twice: twice.code,
        receipt: {
          ok: receipt.ok,
          decision:
            (receiptBody['decision'] as Record<string, unknown> | undefined)?.['id'] ===
            detail(approved)['decisionId'],
          version:
            (receiptBody['version'] as Record<string, unknown> | undefined)?.['id'] === versionId,
          settled: receiptBody['settledMinor'] ?? null,
        },
        execution: { outcome: execution.body['outcome'], kinds: events.map((e) => e.kind) },
        decisions: decisions.map((row) => ({
          decision: row.decision,
          byMia: row.person === world.mia.personId && row.actor === world.mia.actorId,
        })),
      },
      delegationId: delegation.delegation.id,
    };
  }

  beforeAll(async () => {
    world = await createWorld('t2gjourney');
    scratch = mkdtempSync(join(tmpdir(), 't2g-journey-'));
    await world.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [world.alpha],
    );
    // Mia may decide; Ada, the assignee, holds the grant too and is refused on
    // four eyes, not on authority.
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, world.mia as unknown as Member, 'decide');
    });
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);

  it('journey_parity_cli: the command line and the app route record the same journey and refuse the same things', async () => {
    const cli = await journey('cli');
    const app = await journey('app');

    expect(cli.facts.byAssignee).toBe('FOUR_EYES_REQUIRED');
    expect(cli.facts.whileOpen).toBe('GATE_PENDING');
    expect(cli.facts.approved).toBe(true);
    expect(cli.facts.twice).toBe('GATE_ALREADY_DECIDED');
    expect(cli.facts.receipt).toMatchObject({ ok: true, decision: true, version: true });
    expect(cli.facts.execution.outcome).toBe('ready');
    expect(cli.facts.execution.kinds.length).toBeGreaterThan(0);
    // One decision, Mia's own, with no delegation acting: a person's actor.
    expect(cli.facts.decisions).toStrictEqual([{ decision: 'approve', byMia: true }]);
    // The agent is refused and its refusal names the exact delegation.
    expect(cli.facts.agent.ok).toBe(false);
    expect(cli.facts.agent.attempted).toMatchObject({ delegationId: cli.delegationId });
    expect({ ...app.facts, agent: { ...app.facts.agent, attempted: null } }).toEqual({
      ...cli.facts,
      agent: { ...cli.facts.agent, attempted: null },
    });
    expect(app.facts.agent.attempted).toMatchObject({ delegationId: app.delegationId });
  });
});
