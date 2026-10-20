// SPDX-License-Identifier: AGPL-3.0-only
//
// #1626 R12: on the owner's plan, a set's turns go through custody's real
// process to the `chatgpt-plan` route, as the plan's agent turn writes them
// (`chatgptPlanTurnAdapter`), on the set's own plan model, offering only
// `task_read`. The Responses stand-in on loopback answers in the plan's
// stream; custody presents the token and folds the answer. The results file
// records the model the plan named, each case's outcome and the usage, and
// never the token. The plan's usage limit ends a case waiting on the plan's
// allowance, and a case only the fake can give (a scripted rule break or
// fault) is left out on the plan. Astra's review saves beside a plan results
// file as beside the fake's.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LUNA, SOL } from '../../apps/agent-tests/cases.ts';
import { runPlanSet } from '../../apps/agent-tests/plan.ts';
import {
  openPlanRouteWorld,
  toolCallReply,
  words,
  type PlanRouteWorld,
  type Sent,
} from '../custody/fixtures/plan-route-world.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'agent-tests-plan-route-'));
const FULL = 'We are a Townsville agency that builds and maintains websites for clinics.';

let world: PlanRouteWorld;
beforeAll(async () => {
  world = await openPlanRouteWorld();
});
afterAll(async () => {
  await world?.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Body {
  readonly model: string;
  readonly tools?: readonly { readonly name: string }[];
  readonly input: readonly Record<string, unknown>[];
}

const bodyOf = (sent: Sent): Body => JSON.parse(sent.raw) as Body;

/** Reads the task first, then drafts the full correction. */
const readThenDraft = (sent: Sent) =>
  bodyOf(sent).input.some((item) => item['type'] === 'function_call_output')
    ? words(`Drafted the change: "${FULL}"`)
    : toolCallReply('task_read', JSON.stringify({ taskId: 'task-1' }));

it('sends each turn of the harder set to the plan on its own model, and records what the plan answered', async () => {
  world.reply = readThenDraft;
  const before = world.sent.length;
  const results = await runPlanSet(SOL, world.custody);

  const sent = world.sent.slice(before);
  expect(sent).toHaveLength(4);
  for (const one of sent) {
    expect(one.path).toBe('/v1/responses');
    const body = bodyOf(one);
    expect(body.model).toBe('gpt-6.1-sol');
    expect(body.tools?.map((tool) => tool.name)).toEqual(['task_read']);
    expect(body.input[0]).toMatchObject({ role: 'user', content: SOL.cases[0]?.task });
  }
  // The page `task.read` gave the first case reaches the plan as the call's output.
  expect(bodyOf(sent[1] as Sent).input).toContainEqual(
    expect.objectContaining({ type: 'function_call_output', output: SOL.cases[0]?.page }),
  );

  expect(results).toMatchObject({ set: 'sol', provider: 'chatgpt_plan', passed: 2, failed: 0 });
  expect(results.cases.map((one) => [one.model, one.outcome, one.endCode])).toEqual([
    ['gpt-6.1-sol', 'success', 'COMPLETED'],
    ['gpt-6.1-sol', 'success', 'COMPLETED'],
  ]);
  expect(results.usage).toEqual({ inputUnits: 48, outputUnits: 136 });
  expect(JSON.stringify(results)).not.toContain(world.token);
}, 30_000);

it('runs only the luna cases the plan can give, on the smaller model, and the usage limit waits on the allowance', async () => {
  const before = world.sent.length;
  world.reply = () =>
    world.sent.length - before === 1
      ? toolCallReply('task_read', JSON.stringify({ taskId: 'task-1' }))
      : { status: 429, body: JSON.stringify({ error: { code: 'usage_limit_reached' } }) };
  const results = await runPlanSet(LUNA, world.custody);

  expect(world.sent.slice(before).map((one) => bodyOf(one).model)).toEqual([
    'gpt-6.1-luna',
    'gpt-6.1-luna',
  ]);
  expect(results.cases.map((one) => one.id)).toEqual(['drafts-after-reading-its-task']);
  expect(results.cases[0]).toMatchObject({
    endCode: 'LOCAL_PLAN_LIMIT',
    outcome: 'waiting_plan_allowance',
    passed: false,
  });
  expect(results).toMatchObject({ provider: 'chatgpt_plan', passed: 0, failed: 1 });

  const file = join(dir, 'luna-plan.json');
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  const review = join(dir, 'astra.md');
  writeFileSync(review, 'The one case waited on the allowance.\n');
  const saved = spawnSync(process.execPath, ['apps/agent-tests/main.ts', 'review', file, review], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(saved.status, saved.stderr).toBe(0);
  expect(readFileSync(join(dir, 'luna-plan.astra-review.md'), 'utf8')).toBe(
    'The one case waited on the allowance.\n',
  );
}, 30_000);
