// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol r1 proofs on #2180 (S2180-1, S2180-2), unchanged: the real worker's pickup
// credential under a taken launch refuses a task update, the owner's revoke of
// the launch stops its correction, and it keeps task, client and acting
// identity separation.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { ownerLaunchWorld, applied, type OwnerLaunchWorld } from './owner-launch-world.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { COMMAND_SURFACE, pathOf } from '../../packages/core-wire/src/surface.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { insertLogin } from '../identity/fixture.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { authorised, post, tokenFor, BUSINESS_KEY } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- Sol's three proofs, unchanged
describe.skipIf(serverUrl === undefined)('a taken launch’s pickup credential', () => {
  let w: OwnerLaunchWorld;
  beforeEach(async () => {
    w = await ownerLaunchWorld('sol2180');
  }, 180_000);
  afterEach(async () => {
    await w?.fixture.drop();
  });

  async function workerPickup(taskId: string) {
    const launchCredential = await w.takenLaunch(taskId);
    let picked: Record<string, unknown> | undefined;
    const transport: Transport = async (path, body, _bearer, delegation) => {
      // Stop compute after the real worker has obtained its real pickup credential.
      // No handback: the lease remains live for the authority probes below.
      if (path.endsWith('/task/dispatch'))
        return new Response(
          JSON.stringify({
            refused: true,
            code: 'DEPENDENCY_NOT_LANDED',
            names: [],
            fixes: [],
          }),
          { status: 403 },
        );
      const command = COMMAND_SURFACE.find((row) => path.endsWith(pathOf(row.name)))?.name;
      expect(command).toBeDefined();
      const answer = await w.asAgent(command!, JSON.parse(body), delegation);
      if (command === 'task.pickup' && answer.status === 200) picked = applied(answer);
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    };
    const worker = createWorker({
      transport,
      businessKey: 'test',
      credential: 'fixture-agent-login',
      delegation: launchCredential,
      reporter: SYNTHETIC_USAGE,
    });
    const outcome = await worker.applyOnce(taskId);
    expect(picked, JSON.stringify(outcome)).toBeDefined();
    return { launchCredential, picked: picked!, credential: String(picked!['credential']) };
  }

  it('Sol proof, criterion 1: the worker pickup credential refuses arbitrary task updates', async () => {
    const taskId = await w.ownersPlan(`Restricted worker ${randomUUID()}`);
    const { credential } = await workerPickup(taskId);
    const answer = await w.asAgent(
      'task.update',
      {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: await w.revisionOf(taskId),
        fields: { title: 'Worker changed the owner task outside its correction' },
      },
      credential,
    );
    expect({ status: answer.status, code: answer.body['code'] }).toEqual({
      status: 403,
      code: 'DELEGATION_EXCLUDES_OPERATION',
    });
  });

  it('Sol proof, criterion 1: revoking the launch stops the worker correction after pickup', async () => {
    const taskId = await w.ownersPlan(`Revoked worker ${randomUUID()}`);
    const { credential, launchCredential } = await workerPickup(taskId);
    const [launch] = await w.fixture.db.admin.execute<{ delegation_id: string }>(
      'select delegation_id from public.task_launches where business_id = $1 and task_id = $2',
      [w.fixture.business, taskId],
    );
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, w.fixture.member, 'manage');
      await grantTo(tx, w.fixture.member, 'manage', undefined, false, 'access');
    });
    applied(
      await w.as('delegation.revoke', {
        operationId: randomUUID(),
        delegationId: launch!.delegation_id,
      }),
    );
    const revoked = await w.asAgent(
      'session.capabilities',
      { operationId: randomUUID() },
      launchCredential,
    );
    expect(revoked.body['code']).toBe('DELEGATION_NOT_LIVE');
    const page = await w.ownSitePage();
    const answer = await w.asAgent(
      'live_correction.request',
      {
        operationId: randomUUID(),
        taskId,
        page,
        word: 'teh',
        replacement: 'the',
      },
      credential,
    );
    expect({ status: answer.status, code: answer.body['code'] }).toEqual({
      status: 403,
      code: 'DELEGATION_REVOKED',
    });
  });

  // eslint-disable-next-line max-lines-per-function -- Sol's proof, unchanged
  it('Sol proof, criterion 1: pickup keeps client task and acting identity separation', async () => {
    const taskId = await w.ownersPlan(`Own ${randomUUID()}`);
    const other = await w.ownersPlan(`Client task ${randomUUID()}`);
    const client = randomUUID();
    await addClient(w.fixture.db.app, w.fixture.business, client, w.fixture.member);
    await w.fixture.db.admin.execute(
      "update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1",
      [other, client],
    );
    const { credential } = await workerPickup(taskId);
    for (const [command, body] of [
      ['task.read', { recordId: other }],
      [
        'live_correction.request',
        { taskId: other, page: 'https://other.example/', word: 'teh', replacement: 'the' },
      ],
    ] as const) {
      // Sequential: one agent actor and one register.
      // eslint-disable-next-line no-await-in-loop
      const answer = await w.asAgent(command, { operationId: randomUUID(), ...body }, credential);
      expect(answer.status).toBe(403);
      expect(answer.body['code']).toBe('DELEGATION_OUT_OF_PURPOSE');
    }
    const subject = `sol-other-${randomUUID()}`;
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      const actor = randomUUID();
      await tx.query("insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')", [
        tx.businessId,
        actor,
      ]);
      const login = await insertLogin(tx, subject);
      await tx.query(
        'insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id) values ($1, $2, $3, $4, $5)',
        [tx.businessId, randomUUID(), login, actor, w.fixture.member.actorId],
      );
    });
    const stolen = await executeAgentCommand(
      w.fixture.db.app,
      w.fixture.business,
      { provider: 'supabase', subject },
      credential,
      { command: 'session.capabilities', operationId: randomUUID() },
    );
    expect(stolen).toHaveProperty('code', 'DELEGATION_NOT_LIVE');
    const owner = await post(
      w.fixture.compose(),
      `/api/a/b/${BUSINESS_KEY}${pathOf('session.capabilities')}`,
      { operationId: randomUUID() },
      {
        ...authorised(await tokenFor(w.fixture.member.presented.subject)),
        'x-agent-delegation': credential,
      },
    );
    expect(owner.body['code']).toBe('AUTH_NO_AGENT_IDENTITY');
  });
});
