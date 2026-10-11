// SPDX-License-Identifier: AGPL-3.0-only
//
// A parent's completion archives its unfinished steps and its reopening takes
// the mark off, each with an applied event on the step. The step was neither
// completed nor reopened, so the work log does not label it so: the real
// read, drawn by the real Work log component.

import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { made } from '../commands/field-changes-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { Ledger } from '../../packages/ui/src/surfaces/Ledger.tsx';

const configured = databaseUrlFromEnvironment() !== undefined;

let world: AgentWorld;
let writer: Decider;

const send = async (body: Readonly<Record<string, unknown>>) => {
  const result = await world.asPerson(writer, { operationId: randomUUID(), ...body });
  if (isCommandRefusal(result)) throw new Error(`setup refused ${result.code}`);
  return result;
};

/**
 * A parent with one unfinished step, completed and, for a reopen, reopened;
 * the step's state and completion stamp as they were, and its archive mark
 * set only after the completion. Answers the step's title.
 */
async function transitioned(operation: 'task.complete' | 'task.reopen'): Promise<string> {
  const parent = made(
    await send({ command: 'task.create', stateKey: 'active', fields: { title: 'Parent' } }),
  );
  const title = `Unfinished step ${operation}`;
  const step = made(
    await send({ command: 'task.create', parentId: parent.recordId, fields: { title } }),
  );
  const [before] = await world.db.admin.execute<{ state: string }>(
    "select data ->> 'state' as state from public.records where id = $1",
    [step.recordId],
  );
  const completed = made(
    await send({
      command: 'task.complete',
      recordId: parent.recordId,
      expectedRevision: parent.revision,
    }),
  );
  if (operation === 'task.reopen')
    await send({
      command: operation,
      recordId: parent.recordId,
      expectedRevision: completed.revision,
      reason: 'More work',
    });
  const [stored] = await world.db.admin.execute<{
    state: string;
    completed_at: unknown;
    archived: boolean;
  }>(
    `select data ->> 'state' as state, ts_2 as completed_at,
            data ? 'archived_at' as archived from public.records where id = $1`,
    [step.recordId],
  );
  expect(stored?.state).toBe(before?.state);
  expect(stored?.completed_at).toBeNull();
  expect(stored?.archived).toBe(operation === 'task.complete');
  return title;
}

/** The real Work log component, drawn from the real read's events of this task. */
async function workLog(title: string): Promise<string> {
  const result = await executeRead(world.db.app, world.business, writer.presented, {
    read: 'task.ledger',
    timeZone: 'UTC',
  });
  if (isCommandRefusal(result) || !('days' in result)) throw new Error('ledger not answered');
  const days = result.days.map((day) =>
    Object.assign({}, day, { events: day.events.filter((event) => event.task.title === title) }),
  );
  return renderToStaticMarkup(
    createElement(Ledger, {
      days,
      earlier: false,
      loading: false,
      today: new Date().toISOString().slice(0, 10),
      timeZone: 'UTC',
      taskHref: (key: string) => `/task/${key}`,
      onOpenTask: () => {},
      onLoadEarlier: () => {},
    }),
  );
}

describe.skipIf(!configured)('the work log and a step archive mark', () => {
  beforeAll(async () => {
    world = await agentWorld('step_archive_ledger', 'step-archive-ledger');
    writer = await world.decider('Writer');
  }, 120_000);
  afterAll(async () => {
    await world?.drop();
  });

  it.each([
    ['task.complete', 'Completed'],
    ['task.reopen', 'Reopened'],
  ] as const)(
    'an unfinished step its parent’s %s marks is not labelled %s in the work log',
    async (operation, label) => {
      const title = await transitioned(operation);
      // An archive may be shown as an archive, but the step never completed or reopened.
      const html = await workLog(title);
      expect(html).toContain(title);
      expect(html).not.toContain(`>${label}</span>`);
    },
  );
});
