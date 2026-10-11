// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.launch`: a person clicks Launch on a task held by an agent, and a run
// is opened for that agent and task, waiting for the runner
// (`authority/launches.ts`). The envelope has asked `task:assign` of the task
// and holds its lock. Beyond that the launcher must direct the agent, as
// `task.assign` asks (`mayDirectAgent`: its owner, or a holder of
// `agent:assign`). Each refusal writes nothing:
//
// - an agent credential: only a person launches, signed in as themselves;
// - no agent holds the task: `LAUNCH_NO_AGENT`;
// - the task is a client's: `LAUNCH_CLIENT_TASK`. Only internal tasks go to an
//   AI agent for now (owner ruling, 11 Oct 2026);
// - the agent is switched off: `AGENT_NOT_ACTIVE`;
// - the launcher may not direct it: `SCOPE_NOT_GRANTED` naming `agent`;
// - a run of the task is open: `RUN_ALREADY_OPEN`.
//
// The answer names the run and nothing of its credential.

import {
  launchRun,
  mayDirectAgent,
  subjectsOf,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { delegationCredentialKeys } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';

export async function launchTask(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome> {
  const { session, target } = context;
  if (target === undefined) throw new Error('launchTask: the envelope read no target');
  if (session.credentialScope !== undefined) {
    return refused(
      refuseCommand(
        'SCOPE_NOT_GRANTED',
        [],
        ['Only a person launches a run, signed in as themselves.'],
      ),
    );
  }
  const agent = target.data['agent'];
  if (typeof agent !== 'string') {
    return refused(
      refuseCommand(
        'LAUNCH_NO_AGENT',
        ['agent'],
        [
          'This task is not assigned to an AI agent, so there is nothing to launch.',
          'Assign it to one of your agents first.',
        ],
      ),
    );
  }
  const client = target.data['client'];
  if (typeof client === 'string' && client !== '') {
    return refused(
      refuseCommand(
        'LAUNCH_CLIENT_TASK',
        ['client'],
        [
          'Only internal tasks go to an AI agent for now, and this task belongs to a client.',
          'Do this one yourself, or make it an internal task.',
        ],
      ),
    );
  }
  const may = await mayDirectAgent(tx, session.personId, subjectsOf(session), agent);
  if (may === 'missing') {
    return refused(
      refuseCommand(
        'AGENT_NOT_ACTIVE',
        ['agent'],
        [
          'The agent holding this task has been switched off.',
          'Assign the task to an active agent, then launch it.',
        ],
      ),
    );
  }
  if (may === 'not-yours') {
    return refused(
      refuseCommand(
        'SCOPE_NOT_GRANTED',
        ['agent'],
        [
          "That agent belongs to someone else, and you may not direct other people's agents.",
          'Ask its owner to launch it.',
        ],
      ),
    );
  }
  if (!delegationCredentialKeys().ok) {
    return refused(
      refuseCommand(
        'DEPENDENCY_NOT_LANDED',
        ['task.launch'],
        [
          'This deployment has no usable delegation credential key.',
          'It is not a permission problem and retrying will not change it.',
        ],
      ),
    );
  }
  const launched = await launchRun(tx, {
    taskId: target.id,
    agentActorId: agent,
    personId: session.personId,
    actorId: session.actorId,
  });
  if (!launched.ok) return refused(launched.refusal);
  return applied(target.id, target.revision, { runId: launched.launchId, state: 'waiting' });
}
