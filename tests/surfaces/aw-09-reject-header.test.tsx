// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-09, proved for agent output (T3a built it): "Reject this proposal" is the
// proposal's own action on its header, outside the gate card, at parity with
// the API and the command line. The task page is the production screen with
// the production client, signed in as Ada against the real served API, and
// the agent's output is real (a plan picked up and handed back with a
// successor, `aw-09-round-world.ts`).
//
// Both headers that carry it are pressed, the lineage's on the proposal list
// and the Agent pane's, each on an output of its own; the API and the command
// line reject theirs with `task.decide`. The four answers are compared whole
// in the database: the lineage and its gate rejected, one reject recorded on
// the gate, the version kept. A rejected output draws no reject again.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { bearer, createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { serveApi, type ServedApi } from '../cli/cli-process-harness.ts';
import {
  agentOutput,
  asPerson,
  decision,
  type Leg,
  type Output,
  type Round,
} from '../cli/aw-09-round-world.ts';
import { mount, type Mounted } from './mount.tsx';

type Header = 'lineage' | 'pane';

/** Where each header draws its reject for the output's lineage. */
const rejectOn = (header: Header, output: Output): string =>
  header === 'lineage'
    ? `[data-lineage-id="${output.lineageId}"] [data-lineage-action="reject"]`
    : '[data-agent="proposal-header"] [data-agent="reject"]';

/** Real network under jsdom: wait in small steps until `ready` holds. */
async function until(ready: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let step = 0; step < 200; step += 1) {
    // eslint-disable-next-line no-await-in-loop -- one check per step
    if (await ready()) return;
    // eslint-disable-next-line no-await-in-loop -- the page settles between checks
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

// eslint-disable-next-line max-lines-per-function -- one world, four rejects compared whole
describe.skipIf(serverUrl === undefined)('AW-09 reject on the header, for agent output', () => {
  let world: World;
  let api: ServedApi | undefined;
  let scratch: string;
  const r = (): Round => ({ world, api: api as ServedApi, scratch });

  beforeAll(async () => {
    world = await createWorld('aw09rj');
    scratch = mkdtempSync(join(tmpdir(), 'aw-09-rj-'));
    api = await serveApi(world);
    await world.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [world.alpha],
    );
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);

  const facts = async (output: Output) =>
    await world.db.admin.execute<Record<string, unknown>>(
      `select l.state as lineage, g.state as gate,
              (select count(*)::int from public.gate_decisions d
                where d.business_id = g.business_id and d.gate_id = g.id
                  and d.decision = 'reject') as rejects,
              (select count(*)::int from public.proposal_versions v
                where v.business_id = l.business_id and v.lineage_id = l.id) as versions
         from public.proposal_lineages l
         join public.gates g on g.business_id = l.business_id and g.id = $3
        where l.business_id = $1 and l.id = $2`,
      [world.alpha, output.lineageId, output.gateId],
    );

  /** The production task page for the output's task, as Ada over the served API. */
  async function page(output: Output): Promise<Mounted> {
    const read = await asPerson(r(), 'api', 'task.read', { recordId: output.taskId }, ada());
    const key = String((read.body['task'] as { readonly key: string }).key);
    const client = new OperationsClient({
      origin: (api as ServedApi).origin,
      businessKey: 'alpha',
      signedIn: true,
      fetch: async (url, init) =>
        await fetch(url, { ...init, headers: { ...init?.headers, ...bearer(ada()) } }),
    });
    const shown = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey={key} />,
    );
    await until(() => shown.find(`[data-lineage-id="${output.lineageId}"]`) !== null, 'the page');
    return shown;
  }
  const ada = (): string => world.ada.token;

  async function pressed(header: Header): Promise<Output> {
    const output = await agentOutput(r(), 'app', `aw-09 reject ${header}`);
    const shown = await page(output);
    const target = rejectOn(header, output);
    await until(() => shown.host.querySelector(target) !== null, `the ${header} header's reject`);
    expect(shown.find('[data-decide="controls"] [data-lineage-action="reject"]')).toBeNull();
    expect(shown.find('[data-agent="gate"] [data-agent="reject"]')).toBeNull();
    await shown.click(target);
    await until(async () => (await facts(output))[0]?.['lineage'] === 'rejected', 'the reject');
    await shown.unmount();
    return output;
  }

  async function sent(leg: Leg): Promise<Output> {
    const output = await agentOutput(r(), leg, `aw-09 reject ${leg}`);
    const answer = await asPerson(r(), leg, 'task.decide', decision(output, 'reject'), ada());
    expect(answer.ok, JSON.stringify(answer.body)).toBe(true);
    return output;
  }

  it("rejects the agent's output from the proposal header and the Agent pane's, at parity with the API and the command line", async () => {
    const rejected = {
      lineageHeader: await pressed('lineage'),
      paneHeader: await pressed('pane'),
      api: await sent('api'),
      cli: await sent('cli'),
    };
    // The plan is version 1 and the agent's output version 2; both are kept.
    const want = [{ lineage: 'rejected', gate: 'rejected', rejects: 1, versions: 2 }];
    for (const [surface, output] of Object.entries(rejected)) {
      // eslint-disable-next-line no-await-in-loop -- one surface at a time
      expect(await facts(output), surface).toEqual(want);
    }

    // Terminal: the rejected output's page offers no reject on either header.
    const after = await page(rejected.api);
    expect(after.host.querySelector(rejectOn('lineage', rejected.api))).toBeNull();
    expect(after.host.querySelector(rejectOn('pane', rejected.api))).toBeNull();
    await after.unmount();
  }, 300_000);
});
