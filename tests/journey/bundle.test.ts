// SPDX-License-Identifier: AGPL-3.0-only
//
// T4d's invariant, `bundle_names_the_approval` (split section 3.2, T4-R7): the
// evidence bundle's approved action is the decision row the run wrote, byte
// for byte, carried the way the command carries it (a `journey-approval` line
// from the run, parsed by the command, written by the bundle writer). A run
// with no decision in it writes no bundle. `T4 bundle scan`: the bundle holds
// no credential, no canary and no claim of acceptance.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeBundle, type Approval } from '../../scripts/local/journey-bundle.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { serveApi, type ServedApi } from '../cli/cli-process-harness.ts';
import { runPass } from './passes.ts';
import { approvalLine } from './run-approval.ts';

const input = (approval?: Approval) => ({
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  clean: true,
  identity: '{"clean":true}',
  environment: { node: process.version, os: 'test', image: 'postgres@sha256:x', ports: '1 2 3' },
  cases: [{ case: 'journey_twice_same_facts', status: 'pass' as const, detail: 'identical' }],
  budgets: [],
  crashPoints: '',
  approval,
});

describe('bundle_names_the_approval: without a decision', () => {
  it('writes no bundle for a run with no decision in it', () => {
    expect(() => writeBundle(input())).toThrow(/no decision/u);
  });
});

// eslint-disable-next-line max-lines-per-function -- one world, one pass, the bundle and its scan
describe.skipIf(serverUrl === undefined)('bundle_names_the_approval', () => {
  let world: World;
  let served: ServedApi;
  let taskId: string;

  beforeAll(async () => {
    world = await createWorld('t4d_bundle');
    served = await serveApi(world);
    const context = {
      world,
      api: served.origin,
      app: served.origin,
      title: `Bundle ${randomUUID()}`,
    };
    taskId = (await runPass('app', context)).taskId;
  }, 180_000);

  afterAll(async () => {
    await served?.stop();
    await world?.close();
  });

  it("the bundle's approved action is the decision row, byte for byte, as the command carries it", async () => {
    const line = await approvalLine(world.db.admin, world.alpha, taskId);
    const carried = JSON.parse(line.slice('journey-approval '.length)) as Approval;
    const bundle = writeBundle(input(carried));
    const [row] = await world.db.admin.execute<{ id: string; action: string }>(
      `select d.id, d.payload::text as action from public.gate_decisions d
         join public.gates g on g.business_id = d.business_id and g.id = d.gate_id
         join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
        where d.business_id = $1 and l.task_id = $2`,
      [world.alpha, taskId],
    );
    const written = JSON.parse(bundle.json) as { approval: Approval };
    expect(written.approval.decisionId).toBe(row?.id);
    expect(Buffer.from(written.approval.action)).toStrictEqual(Buffer.from(String(row?.action)));
    expect(bundle.markdown).toContain(String(row?.action));
  });

  it('T4 bundle scan: no credential, no canary, no claim of acceptance', async () => {
    const carried = JSON.parse(
      (await approvalLine(world.db.admin, world.alpha, taskId)).slice('journey-approval '.length),
    ) as Approval;
    const bundle = writeBundle(input(carried));
    for (const text of [bundle.json, bundle.markdown]) {
      expect(text).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/u);
      for (const token of [world.ada.token, world.bea.token, world.agent.token]) {
        expect(text).not.toContain(token);
      }
      expect(text).not.toMatch(/\baccepted\b/iu);
    }
    expect(bundle.markdown).toContain("acceptance is the owner's click-through on staging");
  });
});
