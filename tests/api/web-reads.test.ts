// SPDX-License-Identifier: AGPL-3.0-only
//
// The web client's last two reads, through the client itself.
//
// SPEC-ADJUDICATE (b): the web client reaches `task.queue` and `preset.plan`
// with the same permissions as the API and the command line. Until now both
// were outside `READ_NAMES`, so `OperationsClient.read` could not name them
// and the only way through was `mutate()`, with an operation identity a read
// does not carry. These cases drive the real `OperationsClient.read` into the
// real in-process app over a migrated database. The permission is the
// server's, so a reader without `manage` is refused exactly as on the API.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  OperationsClient,
  isRefusal,
  type CallResult,
  type PresetPlanRead,
  type QueueRead,
} from '../../apps/web/src/operations/client.ts';
import type { Member } from '../commands/fixture.ts';
import { tokenFor } from './fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The value of a read that had to succeed. */
function value<T>(result: CallResult<T>): T {
  if (!('ok' in result)) throw new Error(`expected a value, got ${JSON.stringify(result)}`);
  return result.value;
}

describe.skipIf(serverUrl === undefined)('the web client reads task.queue and preset.plan', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('webrd');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  async function clientFor(member: Member): Promise<OperationsClient> {
    const token = await tokenFor(member.presented.subject);
    return new OperationsClient({
      origin: 'http://api.test',
      businessKey: 'alpha',
      token,
      fetch: (async (url: string | URL, init?: RequestInit) =>
        await c.api.fetch(new Request(String(url), init))) as unknown as typeof globalThis.fetch,
    });
  }

  it('reads the queue of approved work awaiting an agent, as a read', async () => {
    const task = await c.createTask('work an agent can pick up');
    const reservationId = await c.approve(await c.propose(task.id, task.revision, 'queue_me'));

    const client = await clientFor(c.manager);
    const answer = value(await client.read<QueueRead>('task.queue', {}));
    expect(answer.ok).toBe(true);
    expect(answer.queue).toContainEqual(
      expect.objectContaining({ reservationId, taskId: task.id, purpose: 'queue_me' }),
    );

    // A read writes one audit row and no register row: it carried no identity.
    expect(
      await c.count(
        `select count(*)::text as n from public.audit_events
          where command = 'task.queue' and outcome = 'applied' and operation_id is null`,
        [],
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await c.count(
        `select count(*)::text as n from public.operations where command = 'task.queue'`,
        [],
      ),
    ).toBe(0);
  });

  it('plans a preset as a dry run for a manager, and names the D05 refusal', async () => {
    const client = await clientFor(c.manager);
    const planned = value(
      await client.read<PresetPlanRead>('preset.plan', {
        recordTypeKey: 'task',
        presetKey: 'web_client',
        fields: [],
      }),
    );
    expect(planned.ok).toBe(true);
    expect(planned.plan.presetKey).toBe('web_client');

    const unclassified = await client.read<PresetPlanRead>('preset.plan', {
      recordTypeKey: 'task',
      presetKey: 'web_client',
      fields: [{ key: 'colour', type: 'text' }],
    });
    expect(isRefusal(unclassified)).toBe(true);
    expect(isRefusal(unclassified) ? unclassified.code : '').toBe('PRESET_FIELD_UNCLASSIFIED');
  });

  it('refuses the planner to a caller without manage, as the API does', async () => {
    const client = await clientFor(c.reader);
    const plan = await client.read<PresetPlanRead>('preset.plan', {
      recordTypeKey: 'task',
      presetKey: 'web_client',
      fields: [],
    });
    expect(isRefusal(plan) ? plan.code : 'not refused').toBe('SCOPE_NOT_GRANTED');
  });
});
