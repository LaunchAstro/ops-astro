// SPDX-License-Identifier: AGPL-3.0-only
//
// Another business's waiting launch, for the cells that aim a `launchId`
// across the business line: bravo's admin creates a task, assigns it to an
// agent of bravo's they own, and launches it, each through the command.

import { agentOwnedBy } from '../commands/fixture.ts';
import type { IdentWorld, RawAnswer } from './ident-audit-cases.ts';

function detail(answer: RawAnswer, what: string): Readonly<Record<string, unknown>> {
  const found = answer.body['detail'] as Record<string, unknown> | undefined;
  if (answer.code !== 'ok' || found === undefined) {
    throw new Error(`foreignLaunch: ${what} refused ${answer.code} ${answer.text}`);
  }
  return found;
}

export async function foreignLaunch(w: IdentWorld): Promise<string> {
  const { world } = w.h;
  const bram = w.foreign.admin;
  const agent = await agentOwnedBy(world.db.app, world.bravo, bram.personId as string);
  const made = await w.person(
    bram,
    'task.create',
    { fields: { title: 'a bravo launch' } },
    'bravo',
  );
  if (made.code !== 'ok') throw new Error(`foreignLaunch: task.create refused ${made.code}`);
  const recordId = made.body['recordId'];
  const assigned = await w.person(
    bram,
    'task.assign',
    { recordId, expectedRevision: made.body['revision'], fields: { agent } },
    'bravo',
  );
  if (assigned.code !== 'ok')
    throw new Error(`foreignLaunch: task.assign refused ${assigned.text}`);
  const launched = await w.person(
    bram,
    'task.launch',
    { recordId, expectedRevision: assigned.body['revision'] },
    'bravo',
  );
  return String(detail(launched, 'task.launch')['runId']);
}
