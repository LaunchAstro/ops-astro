// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn reaches the owner's ChatGPT plan end to end (#2091,
// ROUTE1905), over two turns (#2115): the owner proposes and accepts the plan, so the run
// is his (#1620 P4), and the shipped worker's `main()` runs it with the
// agent's runner on `model.agent_turn` (ROUTE1905A); the API's broker is the
// carried deployment's, made by `carriedBroker` from production-shaped
// settings with one plan route; #2009's carriage takes the turn over the hub
// to the real model agent, whose custody holds the plan's token and sends it
// to the plan's stand-in. Turn 1 offers the plan the agent's two tools and it
// asks to read the task; the worker runs `task.read`; turn 2 carries that
// call and its output back to the plan, which answers in words; the run hands
// back. The hosted side never holds the plan's token: not in its settings, any
// body it sent or answered, what it printed, what it carried, or its rows.
// The one seam is the carriage's transport: the in-process hub in place of
// Supabase Realtime, as #2009's own proofs run it.

import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Transport } from '../../apps/cli/client.ts';
import { main } from '../../apps/worker/main.ts';
import { AGENT_TURN_KEY } from '../../packages/core-connectors/src/index.ts';
import { SIGN_IN_SETTINGS, signedInReach } from '../support/stand-in-gotrue.ts';
import { approve, rows } from '../runtime/schedules-harness.ts';
import { SECRETS } from '../custody/fixtures/plan-answer-world.ts';
import { toolCallReply, words } from '../custody/fixtures/plan-route-world.ts';
import { openCarriedTaskWorld, type CarriedTaskWorld } from '../broker/carried-task-world.ts';
import { unproposed, type Sent } from './compute-seam-world.ts';
import { ownersPlan, plansBroker, settingsOf } from './owners-plan-world.ts';
import { noDatabase, s, useStopWorld } from './run-stop-world.ts';

useStopWorld('planturnend');
afterEach(() => vi.restoreAllMocks());

let world: CarriedTaskWorld;

beforeAll(async () => {
  if (noDatabase) return;
  world = await openCarriedTaskWorld(s);
}, 180_000);

afterAll(async () => {
  await world?.close();
});

/**
 * The worker's transport, accepting the reviewed successor at the hand-back.
 * The shipped worker polls on after its run ends, so past 100 calls every
 * call is refused and `main()` returns.
 */
function accepting(inner: Transport, log: readonly Sent[]): Transport {
  return async (...args) => {
    if (log.length > 100)
      return Response.json(
        { refused: true, code: 'DELEGATION_NOT_LIVE', names: [], fixes: [] },
        { status: 409 },
      );
    const response = await inner(...args);
    const sent = log.at(-1);
    if (sent?.verb === 'task.handback' && response.ok) {
      await approve(s, {
        gateId: sent.detail['successorGateId'],
        versionId: sent.detail['successorVersionId'],
      });
    }
    return response;
  };
}

/** Everything written to stdout and stderr from now until the mocks are restored. */
function printed(): string[] {
  const out: string[] = [];
  const keep = (chunk: string | Uint8Array): boolean => {
    out.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(keep);
  vi.spyOn(process.stderr, 'write').mockImplementation(keep);
  return out;
}

/** The business's rows a hosted function writes or reads for a call, as text. */
async function hostedRows(): Promise<string> {
  const tables = ['model_calls', 'model_call_carriers', 'audit_events', 'operations'];
  const all = await Promise.all(
    tables.map(
      async (table) =>
        await s.db.admin.execute(`select to_jsonb(t)::text as row from public.${table} t`),
    ),
  );
  return JSON.stringify(all);
}

/** The shipped worker's `main()`, signed in as the plan's delegation over `transport`. */
async function shippedMain(
  options: Awaited<ReturnType<typeof unproposed>>['options'],
  transport: Transport,
): Promise<number> {
  return await main(
    [],
    {
      ...SIGN_IN_SETTINGS,
      OPS_ASTRO_BUSINESS: options.businessKey,
      OPS_ASTRO_DELEGATION: options.delegation,
      OPS_ASTRO_WORKER_INTERVAL_MS: '0',
    },
    async () => await Promise.resolve('sent'),
    { ...signedInReach(String(options.credential)), transport: () => transport },
  );
}

/** The agent's turn rows, oldest first: where each went and what it held. */
async function turnRows(): Promise<readonly Record<string, unknown>[]> {
  return await rows<Record<string, unknown>>(
    s,
    `select state, route_key, credential_kind, reserved_minor::int as reserved
       from public.model_calls where business_id = $1 and operation_key = $2
      order by accepted_at`,
    [s.business, AGENT_TURN_KEY],
  );
}

it.skipIf(noDatabase)(
  "the shipped worker drafts through the owner's plan, and no plan token is hosted",
  // oxlint-disable-next-line max-lines-per-function -- one run end to end: two turns, the read between, the search
  async () => {
    const settings = settingsOf(world.carrierAgent);
    const broker = plansBroker(world, settings);
    const { taskId, log, options } = await unproposed('Plan turn end to end', undefined, broker);
    await ownersPlan(taskId);
    const replies = [
      toolCallReply('task_read', JSON.stringify({ taskId }), 'call_read'),
      words('The about page reads well; nothing to correct.'),
    ];
    world.plan.reply = () => replies.shift() ?? words('Asked once too often.');
    const sent = world.plan.sent.length;
    const out = printed();
    const code = await shippedMain(options, accepting(options.transport, log));
    vi.restoreAllMocks();
    const verbs = log.map((call) => call.verb);
    expect(code, JSON.stringify({ out: out.slice(0, 3), verbs })).toBe(0);

    const turns = log.filter((call) => call.verb === 'model.call');
    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      expect(turn).toMatchObject({
        status: 200,
        body: { operation: AGENT_TURN_KEY, kind: 'turn' },
        detail: { state: 'settled' },
      });
    }
    const first = verbs.indexOf('model.call');
    const second = verbs.lastIndexOf('model.call');
    expect(verbs.slice(first + 1, second), 'the read ran between the turns').toContain('task.read');
    expect(world.plan.sent).toHaveLength(sent + 2);
    const [asked, answered] = world.plan.sent.slice(sent).map((one) => JSON.parse(one.raw));
    expect(asked.tools.map((tool: { name: string }) => tool.name)).toStrictEqual([
      'task_read',
      'live_correction_request',
    ]);
    expect(
      answered.input.filter((item: { type?: string }) => item.type !== undefined),
    ).toMatchObject([
      {
        type: 'function_call',
        call_id: 'call_read',
        name: 'task_read',
        arguments: JSON.stringify({ taskId }),
      },
      { type: 'function_call_output', call_id: 'call_read' },
    ]);
    expect(await turnRows()).toMatchObject([
      { state: 'settled', route_key: 'chatgpt_plan', credential_kind: 'subscription', reserved: 0 },
      { state: 'settled', route_key: 'chatgpt_plan', credential_kind: 'subscription', reserved: 0 },
    ]);
    expect(verbs.indexOf('task.comment')).toBeGreaterThan(verbs.indexOf('task.handback'));
    expect(out.join('')).toContain(taskId);

    // The token is on the M5 side, in the request custody wrote, so the search below can find it.
    const written = world.plan.sent.at(-1)?.authorization ?? '';
    expect(written).toContain(world.plan.token);
    const hosted = [
      JSON.stringify(settings),
      JSON.stringify(log),
      out.join(''),
      ...world.carried,
      await hostedRows(),
    ].join('\n');
    for (const secret of [world.plan.token, ...SECRETS]) {
      expect(hosted.includes(secret), 'a plan token reached the hosted side').toBe(false);
    }
  },
  120_000,
);
