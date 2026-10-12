// SPDX-License-Identifier: AGPL-3.0-only
//
// The frontier is a map's open, unblocked and unclaimed tickets. A ticket an
// agent holds is claimed, as `task.claim` already answers, and a ticket its
// map's completion archived is no open work, as the open-task reads already
// treat it. Both leave the frontier in the writing transaction.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentOwnedBy } from '../commands/fixture.ts';
import { must, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the map frontier offers only unclaimed open work', () => {
  let w: WayfinderWorld;
  let owner: Decider;

  beforeAll(async () => {
    w = await wayfinderWorld('wffront', 'wffront');
    owner = await w.decider('owner');
    await w.grant(owner, 'assign');
  }, 180_000);

  afterAll(async () => {
    await w?.drop();
  });

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });

  /** A map holding one open, unblocked research ticket. */
  const mapWithOneTicket = async (title: string) => {
    const answer = await w.as(owner, {
      command: 'map.chart',
      title,
      tickets: [{ ref: 'a', title: `${title} ticket`, type: 'research' }],
    });
    const map = must(answer, 'map.chart').id;
    const ticket = (answer as { detail?: { tickets?: Record<string, string> } }).detail?.tickets?.[
      'a'
    ];
    return { map, ticket: String(ticket) };
  };

  const frontierOf = async (map: string): Promise<readonly string[]> => {
    const answer = (await w.read(owner, { read: 'map.frontier', recordId: map })) as {
      readonly frontier?: readonly { readonly id: string }[];
    };
    if (answer.frontier === undefined) throw new Error('map.frontier was refused');
    return answer.frontier.map((one) => one.id);
  };

  it('a ticket assigned to an agent leaves the frontier', async () => {
    const { map, ticket } = await mapWithOneTicket(`agent held ${randomUUID().slice(0, 6)}`);
    expect(await frontierOf(map)).toStrictEqual([ticket]);
    const agent = await agentOwnedBy(w.db.app, w.business, owner.personId);
    must(
      await w.as(owner, { command: 'task.assign', ...(await at(ticket)), fields: { agent } }),
      'task.assign',
    );
    expect(await frontierOf(map)).toStrictEqual([]);
  });

  it("a ticket archived by its map's completion leaves the frontier", async () => {
    const { map, ticket } = await mapWithOneTicket(`completed ${randomUUID().slice(0, 6)}`);
    expect(await frontierOf(map)).toStrictEqual([ticket]);
    must(await w.as(owner, { command: 'task.complete', ...(await at(map)) }), 'task.complete');
    const [child] = await w.db.admin.execute<{ readonly archived: boolean }>(
      `select data ? 'archived_at' and data ->> 'archived_at' is not null as archived
         from public.records where id = $1`,
      [ticket],
    );
    expect(child).toStrictEqual({ archived: true });
    expect(await frontierOf(map)).toStrictEqual([]);
  });
});
