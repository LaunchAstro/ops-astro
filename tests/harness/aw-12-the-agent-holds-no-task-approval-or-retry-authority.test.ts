// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12 authorities on the real stack (TEST.md 2, #1905): A1 task, A2
// approval and A7 the retry owner. The framework is the shipped agent runner
// (`apps/worker/agent-runner.ts`, core-agent's loop on the pinned stack),
// injected into the shipped worker on a plan a person accepted; every call
// goes through the real HTTP agent door and every turn through the real
// broker to the replay provider. Each case is the agent reaching for an
// authority on its own initiative and the product refusing it, with a
// positive control. A3 to A5 are in `aw-12-authorities-broker.test.ts`, A6
// under kernel confinement, A8 in `aw-12-authorities.test.ts`.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import type { StepContext, StepRunner } from '../../apps/worker/step-runner.ts';
import { REPLAY_TURN } from '../../packages/core-connectors/src/index.ts';
import { appliedDetail, approveBody, asPerson, rows } from '../runtime/schedules-harness.ts';
import { agentBroker, replied } from '../runs/agent-draft-world.ts';
import { acceptedPlan, verbsOf, type Seam } from '../runs/compute-seam-world.ts';
import {
  named,
  noDatabase,
  outcomesOf,
  s,
  shapeOf,
  useStopWorld,
  world,
} from '../runs/run-stop-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('aw12real');

/** The shipped agent runner, keeping each context it computed under: its own resume's checkpoint. */
function remembering(): { readonly runner: StepRunner; readonly seen: StepContext[] } {
  const inner = agentRunner({ operation: REPLAY_TURN.key });
  const seen: StepContext[] = [];
  return {
    seen,
    runner: {
      compute: async (context) => {
        seen.push(context);
        return await inner.compute(context);
      },
    },
  };
}

/** A plan computed by the agent: it reads the task, then answers with `text`. */
async function computed(text: string): Promise<{
  readonly seam: Seam;
  readonly agent: ReturnType<typeof remembering>;
  readonly handedBack: Readonly<Record<string, unknown>>;
}> {
  const agent = remembering();
  const seam = await acceptedPlan(`aw12 real ${randomUUID()}`, agent.runner, agentBroker());
  world.provider.mode('answer');
  world.provider.script([
    replied(`${text} Reading the task.`, [
      { id: 'call_1', name: 'task.read', args: { taskId: seam.taskId } },
    ]),
    replied(`${text} Drafted.`),
  ]);
  const first = await seam.worker.applyOnce(seam.taskId);
  if (!('handedBack' in first)) throw new Error(`hand back: ${JSON.stringify(first)}`);
  return { seam, agent, handedBack: { ...first.handedBack } };
}

/** The review gate's state, as the product's rows hold it. */
const gateState = async (gateId: unknown): Promise<string | undefined> =>
  (await rows<{ state: string }>(s, 'select state from public.gates where id = $1', [gateId]))[0]
    ?.state;

/** A person's decision on the handed-back review gate, through the product's own command. */
const decides = async (handedBack: Readonly<Record<string, unknown>>): Promise<void> => {
  appliedDetail(
    await asPerson(s, { ...approveBody(handedBack), decision: 'reject', note: 'not this one' }),
    'task.decide',
  );
};

/** Every row of every table in the product's schema that holds `canary`, as `table: count`. */
async function holding(canary: string): Promise<string[]> {
  const tables = await rows<{ name: string }>(
    s,
    `select format('%I.%I', schemaname, tablename) as name from pg_tables
      where schemaname = 'public' order by 1`,
    [],
  );
  const found: string[] = [];
  for (const { name } of tables) {
    // oxlint-disable-next-line no-await-in-loop -- one table at a time
    const [hit] = await rows<{ n: string }>(
      s,
      `select count(*)::text as n from ${name} t where t::text like $1`,
      [`%${canary}%`],
    );
    if (hit !== undefined && hit.n !== '0') found.push(`${name}: ${hit.n}`);
  }
  return found;
}

/** What a resume could move: the task's gates, decisions, leases, calls and outcomes. */
const footprint = async (seam: Seam): Promise<readonly unknown[]> =>
  await rows(
    s,
    `select (select string_agg(g.id::text || ':' || g.state, ',' order by g.id) from public.gates g
              join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
              join public.proposal_lineages l on l.business_id = v.business_id and l.id = v.lineage_id
             where l.business_id = $1 and l.task_id = $2) as gates,
            (select count(*) from public.gate_decisions d
              join public.proposal_lineages l on l.business_id = d.business_id and l.id = d.lineage_id
             where l.business_id = $1 and l.task_id = $2) as decisions,
            (select string_agg(le.id::text || ':' || le.state, ',' order by le.id) from public.leases le
              join public.planned_runs r on r.business_id = le.business_id and r.id = le.run_id
             where r.business_id = $1 and r.task_id = $2) as leases,
            (select string_agg(c.id::text || ':' || c.state, ',' order by c.id) from public.model_calls c
             where c.business_id = $1 and c.lease_id = $3 and c.state <> 'refused') as calls`,
    [s.business, seam.taskId, seam.work().picked['leaseId']],
  );

it("A1 task authority: the agent's own state is in no product row, and its next step is a person's decision on the product's rows", async () => {
  const canary = `aw12-plan-canary-${randomUUID()}`;
  const before = world.provider.seen.length;
  const { seam, handedBack } = await computed(canary);
  // Control: the canary was the agent's working state, carried back to the provider in its next turn.
  expect(JSON.stringify(world.provider.seen.slice(before)).includes(canary)).toBe(true);
  expect(shapeOf(await outcomesOf(seam.work()))).toEqual([named('success', 'COMPLETED')]);
  // The attempt's store went with it: none of it is in any product row.
  expect(await holding(canary)).toStrictEqual([]);
  // The next step is the product's: its review gate waits on a person, and their decision moves it.
  expect(await gateState(handedBack['gateId'])).toBe('pending');
  await decides(handedBack);
  expect(await gateState(handedBack['gateId'])).not.toBe('pending');
  expect(await holding(canary)).toStrictEqual([]);
});

it("A2 approval authority: the agent's own resume of its handed-back attempt moves nothing until a person decides", async () => {
  const { seam, agent, handedBack } = await computed('Resume.');
  const [checkpoint] = agent.seen;
  if (checkpoint === undefined) throw new Error('the agent never computed');
  const footprintBefore = await footprint(seam);
  const outcomes = await outcomesOf(seam.work());
  const sent = world.provider.seen.length;
  const verbs = verbsOf(seam).length;

  // Its own resume from its checkpoint: the same attempt, lease and credential, computed again.
  world.provider.script([replied('Drafted again.')]);
  const resumed = await agent.runner.compute(checkpoint);
  expect(resumed.outcome).not.toBe('success');
  // And the worker's next pass with no decision: nothing to pick up, compute or apply.
  await seam.worker.applyOnce(seam.taskId);
  expect(agent.seen).toHaveLength(2);
  expect(world.provider.seen.length, 'nothing sent').toBe(sent);
  expect(await footprint(seam), 'no gate, decision, lease or call moved').toStrictEqual(
    footprintBefore,
  );
  expect(await outcomesOf(seam.work()), 'the attempt keeps its one outcome').toEqual(outcomes);
  expect(
    verbsOf(seam)
      .slice(verbs)
      .filter((verb) => verb === 'task.handback' || verb === 'task.comment'),
    'no handback or effect',
  ).toEqual([]);

  // Control: the person's gate decision is what moves it on.
  expect(await gateState(handedBack['gateId'])).toBe('pending');
  await decides(handedBack);
  expect(await footprint(seam)).not.toStrictEqual(footprintBefore);
});

it('A7 the retry owner: a failed turn is sent once, the agent never sends it again, and the product never re-asks', async () => {
  const agent = remembering();
  const seam = await acceptedPlan(`aw12 retry ${randomUUID()}`, agent.runner, agentBroker());
  const sent = world.provider.seen.length;
  world.provider.mode('unavailable');
  const first = await seam.worker.applyOnce(seam.taskId);
  await seam.worker.applyOnce(seam.taskId);
  world.provider.mode('answer');
  expect(first).not.toHaveProperty('handedBack');
  expect(world.provider.seen.length - sent, 'one send, no retry').toBe(1);
  const calls = await rows<{ state: string; sent: boolean }>(
    s,
    `select state, started_at is not null as sent from public.model_calls
      where business_id = $1 and lease_id = $2 order by accepted_at, id`,
    [s.business, seam.work().picked['leaseId']],
  );
  expect(calls).toEqual([{ state: 'liability_unknown', sent: true }]);
  expect(shapeOf(await outcomesOf(seam.work()))).toEqual([
    named('unknown_provider_outcome', 'LIABILITY_UNKNOWN'),
  ]);
  expect(
    seam.log.filter((entry) => entry.verb === 'task.handback' && entry.status === 200),
    'no handback accepted',
  ).toEqual([]);

  // Control: with the provider answering, the same runner's turn is sent once and succeeds.
  const { seam: clean } = await computed('Clean.');
  expect(shapeOf(await outcomesOf(clean.work()))).toEqual([named('success', 'COMPLETED')]);
});
