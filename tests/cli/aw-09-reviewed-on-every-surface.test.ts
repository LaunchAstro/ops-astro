// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-09's invariant, `agent_output_is_reviewed_on_every_surface`, on the app's
// own client, the API over HTTP and the command line as its own process,
// against the real served API (`aw-09-round-world.ts`).
//
// On each leg the agent's handed-back output lands as a pending gate of its
// own, which the agent cannot decide on the agent prefix nor with its own
// login on the person prefix. A person asks for changes twice; the third ask
// is refused and offers approve, reject or escalate, leaving the gate open.
// The reject is terminal: the rejected version is kept, is not approved again,
// and the lineage takes no new version; the agent's fresh proposal is a new
// lineage with a pending gate of its own. The facts are compared whole across
// the legs, so a surface that answers differently fails here.
//
// The round's one visual operation, the review page, has no JSON answer: the
// command line hands off to the app's own address for it (`review.view`).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type ServedApi } from './cli-process-harness.ts';
import {
  agentOutput,
  asAgent,
  asPerson,
  decision,
  env,
  LEGS,
  PLAN,
  revise,
  versionOf,
  type Leg,
  type Round,
} from './aw-09-round-world.ts';

// eslint-disable-next-line max-lines-per-function -- one round per leg, compared whole
describe.skipIf(serverUrl === undefined)('AW-09 the agent output review round', () => {
  let world: World;
  let api: ServedApi | undefined;
  let scratch: string;
  const r = (): Round => ({ world, api: api as ServedApi, scratch });

  beforeAll(async () => {
    world = await createWorld('aw09');
    scratch = mkdtempSync(join(tmpdir(), 'aw-09-'));
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

  async function gateRow(gateId: string) {
    const [row] = await world.db.admin.execute<{
      readonly state: string;
      readonly round: number;
      readonly kind: string;
    }>(
      `select g.state, g.round, a.kind from public.gates g
         join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
         join public.actors a on a.business_id = v.business_id and a.id = v.proposed_by_actor_id
        where g.business_id = $1 and g.id = $2`,
      [world.alpha, gateId],
    );
    return row;
  }

  // eslint-disable-next-line max-statements, max-lines-per-function -- one leg of the round, read top to bottom
  async function round(leg: Leg) {
    const ada = world.ada.token;
    const output = await agentOutput(r(), leg, `aw-09 ${leg}`);
    const landed = await gateRow(output.gateId);
    const own = await asAgent(
      r(),
      leg,
      'task.decide',
      decision(output, 'approve'),
      output.delegation,
    );
    const ownLogin = await asPerson(
      r(),
      leg,
      'task.decide',
      decision(output, 'approve'),
      world.agent.token,
    );

    const asks: (string | null)[] = [];
    let at: { gateId: string; versionId: string } = output;
    for (let ask = 0; ask < 3; ask += 1) {
      // eslint-disable-next-line no-await-in-loop -- each round decides the version before it
      const answered = await asPerson(
        r(),
        leg,
        'task.decide',
        decision(at, 'request_changes'),
        ada,
      );
      asks.push(answered.ok ? 'applied' : answered.code);
      if (answered.ok) {
        // eslint-disable-next-line no-await-in-loop -- the agent revises after each ask
        at = versionOf(await revise(r(), leg, output));
      } else {
        expect(String(answered.body['fixes'])).toMatch(/approve.*reject.*escalate/isu);
      }
    }
    const third = await gateRow(at.gateId);
    const rejected = await asPerson(r(), leg, 'task.decide', decision(at, 'reject'), ada);
    const again = await asPerson(r(), leg, 'task.decide', decision(at, 'approve'), ada);
    const onLineage = await revise(r(), leg, output);
    const read = await asPerson(r(), leg, 'task.read', { recordId: output.taskId }, ada);
    const task = read.body['task'] as { readonly key: string; readonly revision: number };
    const fresh = await asAgent(
      r(),
      leg,
      'task.propose',
      { recordId: output.taskId, expectedRevision: task.revision, ...PLAN },
      output.delegation,
    );
    const freshGate = await gateRow(versionOf(fresh).gateId);
    const kept = await world.db.admin.execute<{ readonly state: string; readonly n: string }>(
      `select l.state, count(v.id)::text as n from public.proposal_lineages l
         join public.proposal_versions v on v.business_id = l.business_id and v.lineage_id = l.id
        where l.business_id = $1 and l.id = $2 group by l.state`,
      [world.alpha, output.lineageId],
    );
    return {
      key: task.key,
      facts: {
        landed,
        agentDecides: own.code,
        agentLoginDecides: { ok: ownLogin.ok, code: ownLogin.code },
        asks,
        third: third?.state,
        rejected: rejected.ok,
        reapproved: again.ok,
        lineageTakesMore: onLineage.code,
        fresh: { ok: fresh.ok, gate: freshGate, newLineage: fresh.body['detail'] !== undefined },
        kept,
      },
    };
  }

  it('agent_output_is_reviewed_on_every_surface: its own round on the app, the API and the command line', async () => {
    const legs: Partial<Record<Leg, Awaited<ReturnType<typeof round>>>> = {};
    for (const leg of LEGS) {
      // eslint-disable-next-line no-await-in-loop -- one leg at a time on one database
      legs[leg] = await round(leg);
    }
    expect(legs.api?.facts).toEqual({
      landed: { state: 'pending', round: 1, kind: 'agent' },
      agentDecides: 'DELEGATION_EXCLUDES_DECISION',
      agentLoginDecides: { ok: false, code: legs.api?.facts.agentLoginDecides.code },
      asks: ['applied', 'applied', 'CHANGE_ROUNDS_EXHAUSTED'],
      third: 'pending',
      rejected: true,
      reapproved: false,
      lineageTakesMore: 'LINEAGE_TERMINAL',
      fresh: { ok: true, gate: { state: 'pending', round: 1, kind: 'agent' }, newLineage: true },
      kept: [{ state: 'rejected', n: '4' }],
    });
    expect(legs.api?.facts.agentLoginDecides.code).not.toBeNull();
    expect(legs.app?.facts).toEqual(legs.api?.facts);
    expect(legs.cli?.facts).toEqual(legs.api?.facts);

    // The visual half: the command line hands off to the page the app draws.
    const key = String(legs.cli?.key);
    const web = 'http://127.0.0.1:5190';
    const handoff = await runCli(
      ['review.view', '--json', JSON.stringify({ key })],
      env(r(), world.ada.token, { OPS_ASTRO_WEB_URL: web }),
    );
    expect(handoff.code, handoff.stdout + handoff.stderr).toBe(0);
    expect(handoff.json?.['handoff']).toBe(`${web}/task/${encodeURIComponent(key)}`);
  }, 600_000);
});
