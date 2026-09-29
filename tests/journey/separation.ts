// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1's separation, the three crossings the T4 isolation line names, each
// with a positive control so a refusal cannot be a login that works for
// nothing:
//
//   - business to business: bravo's person, on bravo's own prefix, asks for
//     each pass's task; bravo holds a canary task no pass answer may carry;
//   - client to client in one business: an external party of alpha holding a
//     share on one alpha task (their client's) asks for each pass's task;
//   - person to person under a live delegation: the agent, under a live
//     delegation scoped to that shared task, asks for each pass's task.
//
// Each refusal is checked for the refused task's identifier and the pass's
// title, so a refusal that names what it refuses is a leak too.

import { randomUUID } from 'node:crypto';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { DELEGATION_HEADER, PREFIX, pathOf } from '../../packages/core-wire/src/surface.ts';
import { enrolExternal, type Caller } from '../acceptance/world.ts';
import { delegate, personOn, type PassContext, type PassResult } from './passes.ts';
import { holdSecret } from './redact.ts';

export interface Cast {
  readonly canary: { readonly id: string; readonly title: string };
  readonly external: Caller;
  /** The alpha task shared with the external party, and the delegation scoped to it. */
  readonly shared: { readonly id: string; readonly delegation: string };
}

/** Bravo's canary, alpha's external party with one shared task, the agent's delegation on it. */
export async function castSeparation(context: PassContext): Promise<Cast> {
  const { world } = context;
  const title = `Bravo canary ${randomUUID()}`;
  const bravo = personOn('app', context, world.bea.token, 'bravo');
  const canary = await bravo('task.create', { operationId: randomUUID(), fields: { title } });
  const ada = personOn('app', context, world.ada.token);
  const made = await ada('task.create', { operationId: randomUUID(), fields: { title: 'Client' } });
  if (canary.outcome !== 'ok' || made.outcome !== 'ok') {
    throw new Error(`separation cast: ${canary.text} ${made.text}`);
  }
  const shared = String(made.body['recordId']);
  const external = await enrolExternal(world);
  holdSecret(external.token);
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const sharer = { personId: world.ada.personId as string, actorId: world.ada.actorId as string };
    const request = { collection: 'task', recordId: shared, personId: external.personId as string };
    const decided = await shareRecord(tx, sharer, request);
    if (!decided.ok) throw new Error('separation cast: the share was refused');
  });
  return {
    canary: { id: String(canary.body['recordId']), title },
    external,
    shared: { id: shared, delegation: await delegate(world, shared) },
  };
}

/** The agent's read of a task under the delegation, on the agent prefix. */
async function asAgent(context: PassContext, cast: Cast, recordId: string) {
  const response = await fetch(`${context.api}${PREFIX.agent}alpha${pathOf('task.read')}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${context.world.agent.token}`,
      [DELEGATION_HEADER]: cast.shared.delegation,
    },
    // An agent's call carries an operation identity, reads included.
    body: JSON.stringify({ operationId: randomUUID(), recordId }),
  });
  return { ok: response.ok, text: await response.text() };
}

/** Every crossing for every pass, and the positive controls; empty when nothing crossed. */
export async function crossings(
  context: PassContext,
  cast: Cast,
  passes: readonly PassResult[],
): Promise<string[]> {
  const { world } = context;
  const leaks: string[] = [];
  const external = personOn('app', context, cast.external.token);
  const controls = {
    external: await external('task.read', { recordId: cast.shared.id }),
    agent: await asAgent(context, cast, cast.shared.id),
  };
  if (controls.external.outcome !== 'ok') leaks.push(`control: ext ${controls.external.text}`);
  if (!controls.agent.ok) leaks.push(`control: agent ${controls.agent.text}`);
  const each = async (pass: PassResult): Promise<void> => {
    const asked = { recordId: pass.taskId };
    const foreign = personOn(pass.surface, context, world.bea.token, 'bravo');
    const answers = {
      business: await foreign('task.read', asked),
      client: await personOn(pass.surface, context, cast.external.token)('task.read', asked),
    };
    const agent = await asAgent(context, cast, pass.taskId);
    for (const [crossing, answer] of Object.entries(answers)) {
      if (answer.outcome !== 'refused') leaks.push(`${pass.surface} ${crossing}: ${answer.text}`);
    }
    if (agent.ok) leaks.push(`${pass.surface} delegation: ${agent.text}`);
    for (const text of [answers.business.text, answers.client.text, agent.text]) {
      if (text.includes(pass.taskId) || text.includes(context.title)) {
        leaks.push(`${pass.surface}: a refusal names the task: ${text}`);
      }
    }
    const { id, title } = cast.canary;
    if (pass.answers.some((text) => text.includes(id) || text.includes(title))) {
      leaks.push(`${pass.surface}: an answer carries bravo's canary`);
    }
  };
  await Promise.all(passes.map(async (pass) => await each(pass)));
  return leaks;
}
