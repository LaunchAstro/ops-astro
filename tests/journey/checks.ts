// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1: two of the journey's cases, each against the served stack. The live
// update is timed by an in-process event-stream client on the web origin
// (spike RN-01); the command line is run once per declaration against the
// served API, and an invented verb must exit 2 without reaching it (RN-10).

import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { accepts, httpTransport } from '../../apps/cli/client.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { runCli } from '../cli/cli-process-harness.ts';
import { approve, delegate, personOn, type PassContext } from './passes.ts';

/** A task approved and waiting for the worker, for the live check. */
async function approvedTask(context: PassContext): Promise<{
  readonly taskId: string;
  readonly worker: ReturnType<typeof createWorker>;
}> {
  const { world } = context;
  const person = personOn('app', context, world.ada.token);
  const withId = async (name: Parameters<typeof person>[0], body: Record<string, unknown>) =>
    await person(name, { operationId: crypto.randomUUID(), ...body });
  const made = await withId('task.create', { fields: { title: 'Live' } });
  const taskId = String(made.body['recordId']);
  const worker = createWorker({
    transport: httpTransport(context.api),
    businessKey: 'alpha',
    credential: world.agent.token,
    delegation: await delegate(world, taskId),
    reporter: SYNTHETIC_USAGE,
  });
  const proposed = await worker.proposeOnce();
  if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
  await approve(withId, taskId, proposed.proposed.gateId);
  return { taskId, worker };
}

/** RN-01: an in-process event-stream client on the web origin sees the pickup within 2 s. */
export async function liveWithin2s(context: PassContext, web: string): Promise<string> {
  const { taskId, worker } = await approvedTask(context);
  const response = await fetch(`${web}/api/b/alpha/live/task/${taskId}`, {
    headers: { authorization: `Bearer ${context.world.ada.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let text = '';
  const next = async (): Promise<string> => {
    let found = /^event: (\w+)$/mu.exec(text);
    while (found === null) {
      // eslint-disable-next-line no-await-in-loop -- one stream, read in order
      const chunk = await reader.read();
      if (chunk.done) throw new Error('the stream ended');
      text += new TextDecoder().decode(chunk.value);
      found = /^event: (\w+)$/mu.exec(text);
    }
    text = text.slice(found.index + found[0].length);
    return found[1] as string;
  };
  const first = await next();
  if (first !== 'resync') throw new Error(`the first event was ${first}, not resync`);
  const started = performance.now();
  const applied = worker.applyOnce(taskId);
  const kind = await next();
  const ms = Math.round(performance.now() - started);
  await applied;
  await reader.cancel();
  if (ms > 2000) throw new Error(`${kind} after ${String(ms)} ms, over 2000`);
  return `live update: ${kind} after ${String(ms)} ms (budget 2000)`;
}

/** RN-10: one command-line process per declaration; an invented verb sends nothing. */
export async function everyDeclaration(context: PassContext): Promise<string> {
  const cli = { OPS_ASTRO_TOKEN: context.world.ada.token, OPS_ASTRO_API_URL: context.api };
  const faults: string[] = [];
  const started = performance.now();
  for (const { name } of COMMAND_SURFACE) {
    // eslint-disable-next-line no-await-in-loop -- one process at a time, as timed
    const run = await runCli([name, '--business', 'alpha', '--json', '{}'], cli);
    if (run.code !== 0 && run.code !== 1) faults.push(`${name} exit ${String(run.code)}`);
  }
  const ms = Math.round(performance.now() - started);
  const count = 'select count(*) as n from public.audit_events';
  const audited = async (): Promise<string> =>
    String((await context.world.db.admin.execute<{ n: string }>(count))[0]?.n);
  const before = await audited();
  const invented = await runCli(['task.invented', '--business', 'alpha', '--json', '{}'], cli);
  if (invented.code !== 2) faults.push(`task.invented exit ${String(invented.code)}, wanted 2`);
  if ((await audited()) !== before) faults.push('task.invented reached the API');
  if (faults.length > 0) throw new Error(faults.join('; '));
  const visualOnly = COMMAND_SURFACE.filter(({ name }) => !accepts(name)).length;
  return (
    `${String(COMMAND_SURFACE.length)} declarations, one process each, ${String(ms)} ms; ` +
    `invented verb exit 2, nothing sent; visual-only operations, derived from accepts(): ${String(visualOnly)}`
  );
}
