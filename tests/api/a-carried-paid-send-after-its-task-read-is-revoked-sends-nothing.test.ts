// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried paid send is judged again at the send, and the person's task read
// is part of that judgement: every task-read grant revoked after the offer and
// before the agent's accept leaves the page title unsent and the reply
// unanswered.

import { afterEach, expect, it, vi } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, linkableTask } from './carried-schedules.ts';
import { HAIKU } from './openrouter-stand-in-fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

const LIVE_TASK_READS = `select id from public.grants
  where business_id = $1 and collection = 'task' and action = 'read' and revoked_at is null`;

let world: CarriedWorld | undefined;
afterEach(async () => {
  await world?.close();
  vi.unstubAllEnvs();
});

/** Every live task-read grant in the business revoked, as the business's own writer; the count revoked. */
async function revokeTaskReads(current: CarriedWorld): Promise<number> {
  const { fixture } = current.w;
  return await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    const grants = await tx.query<{ id: string }>(LIVE_TASK_READS, [tx.businessId]);
    for (const grant of grants) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction, its statements in order
      await revokeGrant(tx, grant.id);
    }
    return grants.length;
  });
}

it.skipIf(serverUrl === undefined)(
  'revoking task read between the offer and the send sends nothing to the paid provider',
  async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    const current = await carriedWorld('carried_task_read_revoked', undefined, {}, true);
    world = current;
    const { task } = await linkableTask(current);
    const [page] = await current.w.fixture.db.admin.execute<{ title: string }>(
      'select txt_4 as title from public.records where id = $1',
      [task],
    );
    expect(page?.title).toMatch(/^Plan /u);
    let revoked = 0;
    current.agent.beforeAccept = async () => {
      revoked = await revokeTaskReads(current);
    };
    const events = await (
      await ask(current, 'Read revoked once offered', undefined, task, HAIKU)
    ).rest();
    expect(revoked).toBeGreaterThan(0);
    const live = await current.w.count(
      `select count(*)::text as n from (${LIVE_TASK_READS}) live`,
      [current.w.fixture.business],
    );
    expect(live).toBe(0);
    expect(
      current.openrouter?.received,
      'the paid provider received the page title after every task read was revoked',
    ).toHaveLength(0);
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: false } });
  },
  60_000,
);
