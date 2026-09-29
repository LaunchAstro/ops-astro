// SPDX-License-Identifier: AGPL-3.0-only
//
// T3c, `budget.write_off` on every surface, against the real served API: the
// command line as its own process, the HTTP routes it posts to on the agent
// prefix and the person prefix, and the in-process entries the app serves
// through (`T3 write-off authority`).
//
// An agent under the delegation its pickup gave it is refused
// `DELEGATION_EXCLUDES_OPERATION`, and a member without budget permission
// `SCOPE_NOT_GRANTED`, on all three, and the unknown hold does not move; the
// person holding budget permission writes it off on each of the same three.
// No output carries the delegation credential.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executeAgentCommand,
  executeCommand,
  isCommandRefusal,
} from '../../packages/core-commands/src/index.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type Run, type ServedApi } from './cli-process-harness.ts';

const MAXIMUM = 2_000;

function detailOf(run: Run): Record<string, unknown> {
  const detail = run.json?.['detail'];
  if (typeof detail !== 'object' || detail === null) {
    throw new Error(`no detail: ${String(run.code)} ${run.stdout} ${run.stderr}`);
  }
  return detail as Record<string, unknown>;
}

type Surface = 'cli' | 'http' | 'entry';
type Caller = 'agent' | 'member' | 'holder';

describe.skipIf(serverUrl === undefined)('T3c budget.write_off on every surface', () => {
  let world: World;
  let api: ServedApi | undefined;
  let scratch: string;

  const as = (token: string, extra: Readonly<Record<string, string>> = {}) => ({
    OPS_ASTRO_API_URL: (api as ServedApi).origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: token,
    OPS_ASTRO_TOKEN_FILE: join(scratch, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
    ...extra,
  });

  const asAgent = async (credential: string, body: Record<string, unknown>) =>
    await executeAgentCommand(world.db.app, world.alpha, world.agent.presented, credential, {
      operationId: randomUUID(),
      ...body,
    } as never);

  /**
   * Approved work on a new task, picked up by the agent, its effect applied
   * and observed above the hold: an unknown liability (T2d), and a delegation.
   */
  async function unknown(): Promise<{ taskId: string; attemptId: string; credential: string }> {
    const person = as(world.ada.token);
    const task = await runCli(
      ['task.create', '--json', JSON.stringify({ fields: { title: 'write-off surfaces' } })],
      person,
    );
    const taskId = String(task.json?.['recordId']);
    const gate = detailOf(
      await runCli(
        [
          'task.propose',
          '--json',
          JSON.stringify({
            recordId: taskId,
            expectedRevision: task.json?.['revision'],
            purpose: `t3c_${randomUUID().slice(0, 8)}`,
            maximumMinor: MAXIMUM,
            currency: 'AUD',
            payload: { change: 'a team-only comment' },
            step: { kind: 'synthetic_comment', payload: {} },
          }),
        ],
        person,
      ),
    );
    const decided = await runCli(
      [
        'task.decide',
        '--json',
        JSON.stringify({
          gateId: gate['gateId'],
          versionId: gate['versionId'],
          decision: 'approve',
          note: 'approved for the write-off surfaces',
        }),
      ],
      person,
    );
    const file = join(scratch, `delegation-${randomUUID()}`);
    const pickup = await runCli(
      [
        'task.pickup',
        '--agent',
        '--json',
        JSON.stringify({ reservationId: detailOf(decided)['reservationId'] }),
      ],
      as(world.agent.token, { OPS_ASTRO_DELEGATION_FILE: file }),
    );
    expect(pickup.code, pickup.stdout).toBe(0);
    const credential = readFileSync(file, 'utf8').trim();
    const picked = detailOf(pickup);
    const lease = { leaseId: picked['leaseId'], fence: picked['fence'] };
    const attemptId = String(picked['attemptId']);
    expect(
      isCommandRefusal(await asAgent(credential, { command: 'task.dispatch', ...lease })),
    ).toBe(false);
    const effect = await asAgent(credential, {
      command: 'task.comment',
      operationId: effectOperationId(attemptId),
      recordId: taskId,
      body: 'The synthetic change, applied once. Nothing left the app.',
      audience: 'internal',
    });
    expect(isCommandRefusal(effect)).toBe(false);
    const observed = await asAgent(credential, {
      command: 'task.observe',
      ...lease,
      attemptId,
      usage: { item: 'synthetic_comment_long', quantity: 1 },
    });
    // T2d answers a cost above the hold BUDGET_UNAVAILABLE and keeps it unknown.
    expect(isCommandRefusal(observed) && observed.code).toBe('BUDGET_UNAVAILABLE');
    return { taskId, attemptId, credential };
  }

  /** One write-off on one surface by one caller, answered as the code it came back with. */
  async function writeOff(
    surface: Surface,
    caller: Caller,
    work: { taskId: string; attemptId: string; credential: string },
  ): Promise<string> {
    const sent = {
      operationId: randomUUID(),
      recordId: work.taskId,
      attemptId: work.attemptId,
      amountMinor: 0,
      reason: 'The provider never answered and its statement shows no charge.',
    };
    const token = caller === 'member' ? world.mia.token : world.ada.token;
    if (surface === 'cli') {
      const run = await runCli(
        ['budget.write_off', '--json', JSON.stringify(sent)],
        caller === 'agent'
          ? as(world.agent.token, { OPS_ASTRO_AGENT: '1', OPS_ASTRO_DELEGATION: work.credential })
          : as(token),
      );
      expect(run.stdout).not.toContain(work.credential);
      expect(run.stderr).not.toContain(work.credential);
      return run.json?.['refused'] === true ? String(run.json['code']) : 'applied';
    }
    if (surface === 'http') {
      const agent = caller === 'agent';
      const response = await fetch(
        `${(api as ServedApi).origin}${agent ? '/api/a/b/' : '/api/b/'}alpha/budget/write_off`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${agent ? world.agent.token : token}`,
            ...(agent ? { 'x-agent-delegation': work.credential } : {}),
          },
          body: JSON.stringify(sent),
        },
      );
      const text = await response.text();
      expect(text).not.toContain(work.credential);
      const answer = JSON.parse(text) as Record<string, unknown>;
      return answer['refused'] === true ? String(answer['code']) : 'applied';
    }
    const body = { command: 'budget.write_off', ...sent } as never;
    const result =
      caller === 'agent'
        ? await executeAgentCommand(
            world.db.app,
            world.alpha,
            world.agent.presented,
            work.credential,
            body,
          )
        : await executeCommand(
            world.db.app,
            world.alpha,
            (caller === 'member' ? world.mia : world.ada).presented,
            'api',
            body,
          );
    return isCommandRefusal(result) ? result.code : 'applied';
  }

  const holdState = async (attemptId: string): Promise<string | undefined> =>
    (
      await world.db.admin.execute<{ readonly state: string }>(
        `select res.state from public.attempts att
           join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
          where att.id = $1`,
        [attemptId],
      )
    )[0]?.state;

  beforeAll(async () => {
    world = await createWorld('t3csurf');
    scratch = mkdtempSync(join(tmpdir(), 't3c-surfaces-'));
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);

  it('T3 write-off authority: an agent and a member without budget permission are refused on every surface; the holder writes off on each', async () => {
    const surfaces: readonly Surface[] = ['cli', 'http', 'entry'];
    const refusedBy: Record<string, string> = {};
    const work = await unknown();
    for (const surface of surfaces) {
      for (const caller of ['agent', 'member'] as const) {
        // eslint-disable-next-line no-await-in-loop
        refusedBy[`${surface}:${caller}`] = await writeOff(surface, caller, work);
      }
    }
    expect(refusedBy).toStrictEqual({
      'cli:agent': 'DELEGATION_EXCLUDES_OPERATION',
      'cli:member': 'SCOPE_NOT_GRANTED',
      'http:agent': 'DELEGATION_EXCLUDES_OPERATION',
      'http:member': 'SCOPE_NOT_GRANTED',
      'entry:agent': 'DELEGATION_EXCLUDES_OPERATION',
      'entry:member': 'SCOPE_NOT_GRANTED',
    });
    expect(await holdState(work.attemptId)).toBe('held');

    const applied: Record<string, string> = {};
    for (const surface of surfaces) {
      // eslint-disable-next-line no-await-in-loop
      const own = surface === 'cli' ? work : await unknown();
      // eslint-disable-next-line no-await-in-loop
      applied[surface] = await writeOff(surface, 'holder', own);
      // eslint-disable-next-line no-await-in-loop
      expect(await holdState(own.attemptId)).toBe('abandoned');
    }
    expect(applied).toStrictEqual({ cli: 'applied', http: 'applied', entry: 'applied' });
  });
});
