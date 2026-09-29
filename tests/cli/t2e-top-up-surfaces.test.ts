// SPDX-License-Identifier: AGPL-3.0-only
//
// T2e, `budget.top_up` on every surface, against the real served API: the
// command line as its own process, the HTTP routes it posts to on the agent
// prefix and the person prefix, and the in-process entries the app serves
// through.
//
// `top_up_is_a_persons`, its surface half: an agent under the delegation its
// pickup gave it is refused `DELEGATION_EXCLUDES_OPERATION` on the command
// line, the agent route and the agent entry alike, and the envelope does not
// move; the person the delegation came from tops up on each of the same three
// on their own credential. A surface that allows what another refuses fails
// the comparison. No output carries the delegation credential.

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
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type Run, type ServedApi } from './cli-process-harness.ts';

const MAXIMUM = 2_000;
const AMOUNT = 1_000;

function detailOf(run: Run): Record<string, unknown> {
  const detail = run.json?.['detail'];
  if (typeof detail !== 'object' || detail === null) {
    throw new Error(`no detail: ${String(run.code)} ${run.stdout} ${run.stderr}`);
  }
  return detail as Record<string, unknown>;
}

describe.skipIf(serverUrl === undefined)('T2e budget.top_up on every surface', () => {
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

  /** Approved work on a new task, picked up by the agent: the envelope and a delegation. */
  async function planned(): Promise<{ taskId: string; credential: string }> {
    const person = as(world.ada.token);
    const task = await runCli(
      ['task.create', '--json', JSON.stringify({ fields: { title: 'top-up surfaces' } })],
      person,
    );
    const taskId = String(task.json?.['recordId']);
    const proposed = await runCli(
      [
        'task.propose',
        '--json',
        JSON.stringify({
          recordId: taskId,
          expectedRevision: task.json?.['revision'],
          purpose: `t2e_${randomUUID().slice(0, 8)}`,
          maximumMinor: MAXIMUM,
          currency: 'AUD',
          payload: { change: 'a team-only comment' },
          step: { kind: 'synthetic_comment', payload: {} },
        }),
      ],
      person,
    );
    const gate = detailOf(proposed);
    const decided = await runCli(
      [
        'task.decide',
        '--json',
        JSON.stringify({
          gateId: gate['gateId'],
          versionId: gate['versionId'],
          decision: 'approve',
          note: 'approved for the top-up surfaces',
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
    return { taskId, credential: readFileSync(file, 'utf8').trim() };
  }

  const body = (taskId: string, fromMaximumMinor: number) => ({
    operationId: randomUUID(),
    recordId: taskId,
    amountMinor: AMOUNT,
    fromMaximumMinor,
  });

  type Surface = 'cli' | 'http' | 'entry';

  /** One top-up on one surface, answered as the code it came back with. */
  async function topUp(
    surface: Surface,
    taskId: string,
    from: number,
    credential?: string,
  ): Promise<string> {
    const sent = body(taskId, from);
    if (surface === 'cli') {
      const run = await runCli(
        ['budget.top_up', '--json', JSON.stringify(sent)],
        credential === undefined
          ? as(world.ada.token)
          : as(world.agent.token, { OPS_ASTRO_AGENT: '1', OPS_ASTRO_DELEGATION: credential }),
      );
      if (credential !== undefined) {
        expect(run.stdout).not.toContain(credential);
        expect(run.stderr).not.toContain(credential);
      }
      return run.json?.['refused'] === true ? String(run.json['code']) : 'applied';
    }
    if (surface === 'http') {
      const agent = credential !== undefined;
      const response = await fetch(
        `${(api as ServedApi).origin}${agent ? '/api/a/b/' : '/api/b/'}alpha/budget/top_up`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${agent ? world.agent.token : world.ada.token}`,
            ...(agent ? { 'x-agent-delegation': credential } : {}),
          },
          body: JSON.stringify(sent),
        },
      );
      const answer = (await response.json()) as Record<string, unknown>;
      return answer['refused'] === true ? String(answer['code']) : 'applied';
    }
    const result =
      credential === undefined
        ? await executeCommand(world.db.app, world.alpha, world.ada.presented, 'api', {
            command: 'budget.top_up',
            ...sent,
          } as never)
        : await executeAgentCommand(world.db.app, world.alpha, world.agent.presented, credential, {
            command: 'budget.top_up',
            ...sent,
          } as never);
    return isCommandRefusal(result) ? result.code : 'applied';
  }

  const maximumOf = async (taskId: string): Promise<number> =>
    Number(
      (
        await world.db.admin.execute<{ readonly maximum: string }>(
          `select maximum_minor::text as maximum from public.task_envelopes
            where task_id = $1 and state = 'open'`,
          [taskId],
        )
      )[0]?.maximum,
    );

  beforeAll(async () => {
    world = await createWorld('t2esurf');
    scratch = mkdtempSync(join(tmpdir(), 't2e-surfaces-'));
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);

  it('top_up_is_a_persons: refused under a delegation on every surface, and the person succeeds on each', async () => {
    const surfaces: readonly Surface[] = ['cli', 'http', 'entry'];
    const { taskId, credential } = await planned();

    const delegated: Record<string, string> = {};
    for (const surface of surfaces) {
      // eslint-disable-next-line no-await-in-loop
      delegated[surface] = await topUp(surface, taskId, MAXIMUM, credential);
    }
    expect(delegated).toStrictEqual({
      cli: 'DELEGATION_EXCLUDES_OPERATION',
      http: 'DELEGATION_EXCLUDES_OPERATION',
      entry: 'DELEGATION_EXCLUDES_OPERATION',
    });
    expect(await maximumOf(taskId)).toBe(MAXIMUM);

    const own: Record<string, string> = {};
    let from = MAXIMUM;
    for (const surface of surfaces) {
      // eslint-disable-next-line no-await-in-loop
      own[surface] = await topUp(surface, taskId, from);
      from += AMOUNT;
    }
    expect(own).toStrictEqual({ cli: 'applied', http: 'applied', entry: 'applied' });
    expect(await maximumOf(taskId)).toBe(MAXIMUM + 3 * AMOUNT);
  }, 180_000);
});
