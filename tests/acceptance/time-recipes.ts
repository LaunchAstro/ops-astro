// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control recipes for the five `time.*` commands (MP-4-6), kept
// beside `role-case-positive-body.ts`, which places them in its table.
//
// A harness, not a suite: nothing here runs on its own.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

/** What the recipes need of `role-case-bodies.ts`'s context, and nothing else. */
interface TimeContext {
  readonly alphaTaskId: string;
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
  freshTask(title: string): Promise<{ readonly id: string }>;
}

type Prepared = { readonly body: Record<string, unknown> };

type TimeCommand = 'time.start' | 'time.stop' | 'time.log' | 'time.set_note' | 'time.delete';

/**
 * The context person's own time (MP-4-6). A person has one running timer, so
 * the start recipe stops the timer it last started before naming a fresh
 * task, and the stop recipe starts one for its body to stop.
 */
export function timeRecipes(
  context: TimeContext,
): Readonly<Record<TimeCommand, () => Promise<Prepared>>> {
  let timed: string | undefined;
  const fresh = async (): Promise<string> => {
    if (timed !== undefined) await context.asPerson('time.stop', { taskId: timed });
    timed = (await context.freshTask('a task the admin times')).id;
    return timed;
  };
  const entry = async (): Promise<string> => {
    const body = { taskId: context.alphaTaskId, duration: '5' };
    const logged = await context.asPerson('time.log', body);
    if (logged.code !== 'ok') throw new Error(`matrix: time.log refused ${logged.code}`);
    return String((logged.body['detail'] as Record<string, unknown>)['entryId']);
  };
  return {
    'time.start': async () => ({ body: { taskId: await fresh() } }),
    'time.stop': async () => {
      const taskId = await fresh();
      const started = await context.asPerson('time.start', { taskId });
      if (started.code !== 'ok') throw new Error(`matrix: time.start refused ${started.code}`);
      return { body: { taskId } };
    },
    'time.log': () =>
      Promise.resolve({
        body: { taskId: context.alphaTaskId, duration: '1h 30m', note: 'logged by the admin' },
      }),
    'time.set_note': async () => ({ body: { entryId: await entry(), note: 'the admin notes it' } }),
    'time.delete': async () => ({ body: { entryId: await entry() } }),
  };
}
