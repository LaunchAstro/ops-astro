// SPDX-License-Identifier: AGPL-3.0-only
//
// Demo data for a live business (register 253, #2211): the plan in
// `demo-data-plan.ts`, written as the signed-in person through the product's
// own commands, so every row is audited and judged by the grants.
// `demo-data.mjs` runs it; this file decides and sends.
//
// The safeguards are checked here, before a run and at every send:
// - every client, tag, task and thread is named `Demo …` and its id goes into
//   the manifest the moment it is made;
// - text holds reserved addresses only (example.com and .test), and no run of
//   six digits, so no phone number;
// - a command outside `ALLOWED` is refused, as is a mention, a client-audience
//   comment, an assignee, a page link, a model, and a write to any record this
//   run did not make; so nothing is assigned, launched, invited or mailed, and
//   nothing real is edited;
// - each side chat is scoped to a task with a client, so no model is asked
//   (`conversation-context.ts`: a client's task answers CLIENT_MODEL_USE_OFF);
// - a proposal's ceiling is AUD 5 at most, and its step is never the
//   worker's, whose pickup takes only its own launched task anyway.
// Removal (`demo-data-remove.ts`) trashes only the manifest's tasks, each read first and refused
// unless its title is still the demo one. No command removes a client, a tag
// or a thread (#2209), so those stay, named Demo.

import { CLIENTS, START_STATE, TAG, TASKS, THREADS, type DemoTask } from './demo-data-plan.ts';
import {
  applied,
  guarded,
  inner,
  MAX_CEILING_MINOR,
  NEEDED,
  op,
  planProblems,
  Refusal,
  type Body,
  type Made,
  type Manifest,
  type Send,
} from './demo-data-checks.ts';

export { CLIENTS, TAG, TASKS, THREADS } from './demo-data-plan.ts';
export { MAX_CEILING_MINOR, NEEDED, Refusal } from './demo-data-checks.ts';
export type { Body, Made, Manifest, Send } from './demo-data-checks.ts';
export { remove } from './demo-data-remove.ts';

// --- Seeding ------------------------------------------------------------

/** One run's state: what is made so far, and the guarded send. */
interface Run {
  readonly manifest: Manifest;
  readonly send: Send;
  readonly done: Map<string, Made>;
  readonly ours: Set<string>;
  readonly gates: Set<string>;
  readonly fresh: Made[];
  readonly save: () => void;
}

/**
 * One step, unless the manifest already holds it. Its manifest entry is
 * saved before the next step is sent, and its operation id is fixed by the
 * batch and the step, so a step whose answer was lost replays when rerun.
 */
async function step(
  run: Run,
  key: string,
  verb: string,
  body: Body,
  made: (answer: Body) => Omit<Made, 'step'>,
): Promise<Made> {
  const had = run.done.get(key);
  if (had !== undefined) return had;
  const answer = applied(
    await run.send(verb, { operationId: op(run.manifest, key), ...body }),
    verb,
  );
  const entry: Made = { step: key, ...made(answer) };
  run.manifest.made.push(entry);
  run.done.set(key, entry);
  run.ours.add(entry.id);
  if (entry.gateId !== undefined) run.gates.add(entry.gateId);
  run.fresh.push(entry);
  run.save();
  return entry;
}

/**
 * Seed every step not yet in the manifest, in order; the steps made this run.
 * `save` is called after each, so a stop leaves a manifest that removal and a
 * rerun both read.
 */
export async function seed(raw: Send, manifest: Manifest, save: () => void): Promise<Made[]> {
  const problems = planProblems();
  if (problems.length > 0) throw new Refusal(problems.join('; '));
  const ours = new Set(manifest.made.map((m) => m.id));
  const gates = new Set(manifest.made.flatMap((m) => (m.gateId === undefined ? [] : [m.gateId])));
  const send = guarded(raw, ours, gates);
  const run: Run = {
    manifest,
    send,
    done: new Map(manifest.made.map((m) => [m.step, m])),
    ours,
    gates,
    fresh: [],
    save,
  };
  await checkGrants(send);
  const clients = new Map<string, string>();
  for (const [index, name] of CLIENTS.entries()) {
    // In order: each step is saved before the next is sent.
    // oxlint-disable-next-line no-await-in-loop
    const made = await step(run, `client:${String(index)}`, 'client.create', { name }, (a) => ({
      kind: 'client',
      id: String(inner(a)['clientId'] ?? a['recordId']),
      name,
    }));
    clients.set(name, made.id);
  }
  const tag = await step(run, 'tag', 'tag.create', { name: TAG }, (a) => ({
    kind: 'tag',
    id: String(inner(a)['tagId']),
    name: TAG,
  }));
  const taskIds = new Map<string, string>();
  for (const [index, task] of TASKS.entries()) {
    // oxlint-disable-next-line no-await-in-loop
    taskIds.set(task.title, await seedTask(run, task, index, clients, tag.id));
  }
  for (const [index, thread] of THREADS.entries()) {
    const scope = { kind: 'task', id: taskIds.get(thread.task) ?? '' };
    // oxlint-disable-next-line no-await-in-loop
    await step(
      run,
      `thread:${String(index)}`,
      'conversation.start',
      { body: thread.body, title: thread.title, scope },
      (a) => ({ kind: 'thread', id: String(inner(a)['conversationId']), name: thread.title }),
    );
  }
  return run.fresh;
}

/** One task, from its creation to its end state; its id. */
async function seedTask(
  run: Run,
  task: DemoTask,
  index: number,
  clients: ReadonlyMap<string, string>,
  tagId: string,
): Promise<string> {
  const key = `task:${String(index)}`;
  const stateKey = START_STATE[task.end];
  const created = await step(
    run,
    key,
    'task.create',
    {
      fields: taskFields(task, index, run.manifest.createdAt),
      ...(stateKey === undefined ? {} : { stateKey }),
    },
    (a) => ({
      kind: 'task',
      id: String(a['recordId']),
      name: task.title,
      revision: Number(a['revision']),
    }),
  );
  const on = onTask(run, key, created);
  // The client first: it locks once the task has content (`click-through-work.mjs`).
  if (task.client !== null)
    await on('client', 'task.set_party', { fields: { client: clients.get(task.client) } });
  await on('tag', 'task.add_tag', { tagId }, { revisioned: false });
  for (const [n, body] of (task.comments ?? []).entries()) {
    // oxlint-disable-next-line no-await-in-loop
    await on(
      `comment:${String(n)}`,
      'task.comment',
      { body, audience: 'internal' },
      { kind: 'comment' },
    );
  }
  if (task.end === 'in_progress' || task.end === 'done') await on('start', 'task.start', {});
  if (task.end === 'done') await on('complete', 'task.complete', {});
  if (task.plan !== undefined) await playBack(run, key, task, task.plan, created.id, on);
  return created.id;
}

/** The plan played back for review: proposed, and approved when the task ends accepted. */
async function playBack(
  run: Run,
  key: string,
  task: DemoTask,
  plan: NonNullable<DemoTask['plan']>,
  taskId: string,
  on: ReturnType<typeof onTask>,
): Promise<void> {
  const proposal = await on(
    'propose',
    'task.propose',
    {
      purpose: plan.purpose,
      maximumMinor: task.end === 'accepted' ? 300 : MAX_CEILING_MINOR,
      currency: 'AUD',
      payload: { plan: plan.steps },
      step: { kind: 'demo_plan', payload: { steps: plan.steps } },
      expiresInSeconds: 604_800,
    },
    { kind: 'proposal' },
  );
  if (task.end !== 'accepted') return;
  const decision = { gateId: proposal.gateId, versionId: proposal.versionId, decision: 'approve' };
  await step(run, `${key}:approve`, 'task.decide', { ...decision, note: 'Demo approval' }, () => ({
    kind: 'state',
    id: taskId,
  }));
}

function taskFields(task: DemoTask, index: number, createdAt: string): Body {
  return {
    title: task.title,
    description: task.description,
    due: new Date(Date.parse(createdAt) + (7 + index) * 86_400_000).toISOString(),
    estimated_minutes: 30 + 15 * (index % 4),
    ...(task.brief === undefined ? {} : { agent_brief: task.brief }),
  };
}

/** The steps on one task, each against the revision the last one left. */
function onTask(run: Run, key: string, created: Made) {
  let revision = created.revision ?? 0;
  return async (
    suffix: string,
    verb: string,
    body: Body,
    options: { readonly revisioned?: boolean; readonly kind?: Made['kind'] } = {},
  ): Promise<Made> => {
    const kind = options.kind ?? 'state';
    const sent = {
      recordId: created.id,
      ...(options.revisioned === false ? {} : { expectedRevision: revision }),
      ...body,
    };
    const made = await step(run, `${key}:${suffix}`, verb, sent, (a) => {
      const d = inner(a);
      return {
        kind,
        id: kind === 'comment' ? String(d['commentId']) : created.id,
        revision: typeof a['revision'] === 'number' ? a['revision'] : revision,
        ...(typeof d['gateId'] === 'string'
          ? { gateId: d['gateId'], versionId: String(d['versionId']) }
          : {}),
      };
    });
    revision = made.revision ?? revision;
    return made;
  };
}

/**
 * Every grant the run's commands need, before anything is written. The pairs
 * are the caller's live ones (`reads/capabilities.ts`); each write is still
 * judged by the server at its own scope.
 */
async function checkGrants(send: Send): Promise<void> {
  const answer = applied(await send('session.capabilities', {}), 'session.capabilities');
  const held = new Set(
    ((answer['grants'] ?? []) as readonly Body[]).map(
      (g) => `${String(g['collection'])}:${String(g['action'])}`,
    ),
  );
  const missing = NEEDED.filter((grant) => !held.has(grant));
  if (missing.length > 0) throw new Refusal(`this sign-in lacks ${missing.join(' ')}`);
}
