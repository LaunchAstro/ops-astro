// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1: one journey, driven once per surface against a served API process.
// The person's steps go through the app's own operations client (the module
// the screens call, posting to the web origin when one is served) or through
// one command-line process per call; the agent's steps go through the shipped
// worker module over HTTP in both, so the two passes differ only in the
// person's surface. Each pass: create a task, let the worker propose, read
// the version, approve it, let the worker apply it once, read the receipt and
// the run. The facts it leaves are then read back (`facts.ts`).
//
// Every write carries an operation identity chosen here and every answer is
// kept, so the restart step can send the same writes again and compare the
// bodies byte for byte (CQ-14's replay compare, product issue 58).

import { randomUUID } from 'node:crypto';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { declarationOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { httpTransport } from '../../apps/cli/client.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import type { World } from '../acceptance/world.ts';
import { runCli } from '../cli/cli-process-harness.ts';
import { readFacts, type JourneyFacts } from './facts.ts';
import { holdSecret } from './redact.ts';

export type Surface = 'app' | 'cli';

export interface Answer {
  readonly outcome: 'ok' | 'refused' | 'fault';
  readonly body: Record<string, unknown>;
  /** The answer as one compact JSON line, the form the replay compares. */
  readonly text: string;
}

/** A person's call through one surface. */
export type Person = (name: CommandName, body: Record<string, unknown>) => Promise<Answer>;

export interface Sent {
  readonly name: CommandName;
  readonly body: Record<string, unknown>;
  readonly answer: string;
}

export interface PassResult {
  readonly surface: Surface;
  readonly taskId: string;
  readonly facts: JourneyFacts;
  /** Every write the person sent, with its operation identity and answer. */
  readonly sent: readonly Sent[];
  /** Every answer the person was given, for the separation check. */
  readonly answers: readonly string[];
}

export interface PassContext {
  readonly world: World;
  /** The served API process: the worker and the command line post here. */
  readonly api: string;
  /** Where the app's client posts: the web origin, or the API when none is served. */
  readonly app: string;
  /** The same title in both passes, so the facts can match. */
  readonly title: string;
}

function answerOf(outcome: Answer['outcome'], body: unknown): Answer {
  const object = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return { outcome, body: object, text: JSON.stringify(body ?? null) };
}

/** The app's own client, as the screens hold it. */
export function appPerson(origin: string, businessKey: string, token: string): Person {
  const client = new OperationsClient({ origin, businessKey, token, fetch: globalThis.fetch });
  return async (name, body) => {
    const { operationId, ...rest } = body;
    const result =
      declarationOf(name).kind === 'read'
        ? await client.read(name as Parameters<OperationsClient['read']>[0], rest)
        : await client.mutate(name as never, rest, { operationId: operationId as string });
    if ('ok' in result) return answerOf('ok', result.value);
    return answerOf('refused' in result ? 'refused' : 'fault', result);
  };
}

/** One command-line process per call, against the served API. */
export function cliPerson(api: string, businessKey: string, token: string): Person {
  return async (name, body) => {
    const run = await runCli([name, '--business', businessKey, '--json', JSON.stringify(body)], {
      OPS_ASTRO_TOKEN: token,
      OPS_ASTRO_API_URL: api,
    });
    const outcome = run.code === 0 ? 'ok' : run.code === 1 ? 'refused' : 'fault';
    return answerOf(outcome, run.json ?? { stdout: run.stdout, stderr: run.stderr });
  };
}

export function personOn(
  surface: Surface,
  context: PassContext,
  token: string,
  businessKey = 'alpha',
): Person {
  return surface === 'app'
    ? appPerson(context.app, businessKey, token)
    : cliPerson(context.api, businessKey, token);
}

function must(answer: Answer, what: string): Record<string, unknown> {
  if (answer.outcome !== 'ok') throw new Error(`${what}: ${answer.text.slice(0, 400)}`);
  return answer.body;
}

/** The delegation the worker acts under, minted as the seed mints one. */
export async function delegate(world: World, taskId: string): Promise<string> {
  return await world.db.app.withBusiness(world.alpha, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: world.agent.actorId,
      delegatePersonId: world.ada.personId as string,
      mintedByActorId: world.ada.actorId as string,
      purpose: `journey_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'comment', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`journey: delegation refused ${minted.refusal.code}`);
    return holdSecret(minted.value.credential);
  });
}

/** The person reads the proposed version and approves exactly that one. */
export async function approve(person: Person, taskId: string, gateId: string): Promise<void> {
  const read = must(await person('task.read', { recordId: taskId }), 'read');
  const task = read['task'] as { proposals: { versions: { versionId: string }[] }[] };
  const versionId = String(task.proposals[0]?.versions[0]?.versionId);
  const decision = { gateId, versionId, decision: 'approve', note: 'approve this version' };
  must(await person('task.decide', decision), 'decide');
}

/** The whole journey through one surface, and the facts it left. */
export async function runPass(surface: Surface, context: PassContext): Promise<PassResult> {
  const { world } = context;
  const sent: Sent[] = [];
  const answers: string[] = [];
  const raw = personOn(surface, context, world.ada.token);
  const person: Person = async (name, body) => {
    const write = declarationOf(name).kind === 'write';
    const full = write ? { operationId: randomUUID(), ...body } : body;
    const answer = await raw(name, full);
    answers.push(answer.text);
    if (write) sent.push({ name, body: full, answer: answer.text });
    return answer;
  };

  const created = must(await person('task.create', { fields: { title: context.title } }), 'create');
  const taskId = String(created['recordId']);
  const worker = createWorker({
    transport: httpTransport(context.api),
    businessKey: 'alpha',
    credential: world.agent.token,
    delegation: await delegate(world, taskId),
    reporter: SYNTHETIC_USAGE,
  });
  const proposed = await worker.proposeOnce();
  if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
  await approve(person, taskId, proposed.proposed.gateId);
  const applied = await worker.applyOnce(taskId);
  if (!('applied' in applied)) throw new Error(`apply: ${JSON.stringify(applied)}`);
  const receipt = must(
    await person('task.receipt', { attemptId: applied.applied.attemptId }),
    'receipt',
  );
  must(await person('task.execution', { recordId: taskId }), 'execution');
  // The pickup's delegation stays live after settlement at this head, and an
  // agent holds one per purpose, so the person ends it, as a person would
  // before the next task (`delegation.revoke`, on the same surface).
  const [held] = await world.db.admin.execute<{ id: string }>(
    `select id from public.delegations where business_id = $1 and agent_actor_id = $2
        and purpose = 'synthetic_comment' and revoked_at is null and settled_at is null`,
    [world.alpha, world.agent.actorId],
  );
  if (held !== undefined) {
    must(await person('delegation.revoke', { delegationId: held.id }), 'revoke');
  }
  const facts = await readFacts(world.db.admin, world.alpha, taskId, receipt['receipt']);
  return { surface, taskId, facts, sent, answers };
}
