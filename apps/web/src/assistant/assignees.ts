// SPDX-License-Identifier: AGPL-3.0-only
//
// Who a chat card's new task goes to (the owner's call on chat-made tasks):
// the person who clicked Create, as `team.list` names the reader (`you`). Once
// the create answers, the click's `task.assign` gives the task to them at the
// revision the create returned, under the reply's own operation id. The body
// is the session's own person every time, so a retry, a reload's included,
// presents the same attempt and the register replays its first outcome.

import type { AssistantProposal } from '@launchastro/ui';
import { proposalAssign, type TeamListResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';

const NOT_ASSIGNED = 'The task was created but not assigned:';

/** The new task's assignment to the clicker: null once kept, else how the card settles. */
export async function assignClicker(
  client: OperationsClient,
  source: string,
  task: { readonly recordId: string; readonly revision: number },
): Promise<Pick<AssistantProposal, 'state' | 'refusal'> | null> {
  const team = settle(await client.read<TeamListResult>('team.list', {}));
  if (team.kind === 'unknown') return { state: 'unknown', refusal: team.because };
  if (team.kind !== 'ok') return { state: 'made', refusal: `${NOT_ASSIGNED} ${team.because}` };
  const write = proposalAssign(source, task, team.value.you.toLowerCase());
  const settled = settle(
    await client.mutate('task.assign', write.body, {
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    }),
  );
  if (settled.kind === 'ok') return null;
  if (settled.kind === 'unknown') return { state: 'unknown', refusal: settled.because };
  return { state: 'made', refusal: `${NOT_ASSIGNED} ${settled.because}` };
}
