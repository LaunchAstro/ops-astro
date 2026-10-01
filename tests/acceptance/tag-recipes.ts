// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control recipes for the three tag commands and the vocabulary
// read (MP-4-11), kept beside `role-case-positive-body.ts`, which places them
// in its table.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

/** What the recipes need of `role-case-bodies.ts`'s context, and nothing else. */
interface TagContext {
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
  freshTask(title: string): Promise<{ readonly id: string }>;
}

type Prepared = { readonly body: Record<string, unknown> };

type TagCommand = 'tag.create' | 'task.add_tag' | 'task.remove_tag' | 'tag.list';

/** A fresh name each call: the vocabulary takes a name once. */
const freshName = (): string => `tag ${randomUUID().slice(0, 8)}`;

/**
 * The context person's tags on a fresh task (MP-4-11). Each recipe makes its
 * own tag, so a recipe run twice never meets its first run's name or row.
 */
export function tagRecipes(
  context: TagContext,
): Readonly<Record<TagCommand, () => Promise<Prepared>>> {
  const tag = async (): Promise<string> => {
    const made = await context.asPerson('tag.create', { name: freshName() });
    if (made.code !== 'ok') throw new Error(`matrix: tag.create refused ${made.code}`);
    return String((made.body['detail'] as Record<string, unknown>)['tagId']);
  };
  const task = async (): Promise<string> => (await context.freshTask('a task the admin tags')).id;
  return {
    'tag.create': () => Promise.resolve({ body: { name: freshName() } }),
    'task.add_tag': async () => ({ body: { recordId: await task(), tagId: await tag() } }),
    'task.remove_tag': async () => {
      const body = { recordId: await task(), tagId: await tag() };
      const added = await context.asPerson('task.add_tag', body);
      if (added.code !== 'ok') throw new Error(`matrix: task.add_tag refused ${added.code}`);
      return { body };
    },
    'tag.list': () => Promise.resolve({ body: {} }),
  };
}
