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
  type RefusalCode,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { delegationCredentialKeys } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';

/** One refusal of this command, writing nothing. */
const no = (
  code: RefusalCode,
  names: readonly string[],
  fixes: readonly string[],
): HandlerOutcome => refused(refuseCommand(code, names, fixes));

/** Why this task cannot be launched by anyone: no agent holds it, or it is a client's. */
async function taskRefusal(
  tx: TenantQuery,
  taskId: string,
  data: Readonly<Record<string, unknown>>,
): Promise<HandlerOutcome | undefined> {
  if (typeof data['agent'] !== 'string') {
    return no(
      'LAUNCH_NO_AGENT',
      ['agent'],
      [
        'This task is not assigned to an AI agent, so there is nothing to launch.',
        'Assign it to one of your agents first.',
      ],
    );
  }
  // The task's client as every read takes it, its slot (`task-content.ts`),
  // read under the task lock the envelope holds.
  const [slot] = await tx.query<{ readonly client: boolean }>(
    'select uuid_7 is not null as client from public.records where business_id = $1 and id = $2',
    [tx.businessId, taskId],
  );
  if (slot?.client === true) {
    return no(
      'LAUNCH_CLIENT_TASK',
      ['client'],
      [
        'Only internal tasks go to an AI agent for now, and this task belongs to a client.',
        'Do this one yourself, or make it an internal task.',
      ],
    );
  }
  return undefined;
}

/** Why this caller may not launch this task's agent now, or undefined. */
async function refusalOf(
  tx: TenantQuery,
  context: CommandContext,
  taskId: string,
  data: Readonly<Record<string, unknown>>,
): Promise<HandlerOutcome | undefined> {
  const { session } = context;
  if (session.credentialScope !== undefined) {
    return no('SCOPE_NOT_GRANTED', [], ['Only a person launches a run, signed in as themselves.']);
  }
  const unlaunchable = await taskRefusal(tx, taskId, data);
  if (unlaunchable !== undefined) return unlaunchable;
  const agent = String(data['agent']);
  const may = await mayDirectAgent(tx, session.personId, subjectsOf(session), agent);
  if (may === 'missing') {
    return no(
      'AGENT_NOT_ACTIVE',
      ['agent'],
      [
        'The agent holding this task has been switched off.',
        'Assign the task to an active agent, then launch it.',
      ],
    );
  }
  if (may === 'not-yours') {
    return no(
      'SCOPE_NOT_GRANTED',
      ['agent'],
      [
        "That agent belongs to someone else, and you may not direct other people's agents.",
        'Ask its owner to launch it.',
      ],
    );
  }
  if (delegationCredentialKeys().ok) return undefined;
  return no(
    'DEPENDENCY_NOT_LANDED',
    ['task.launch'],
    [
      'This deployment has no usable delegation credential key.',
      'It is not a permission problem and retrying will not change it.',
    ],
  );
}

export async function launchTask(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome> {
  const { session, target } = context;
  if (target === undefined) throw new Error('launchTask: the envelope read no target');
  const refusal = await refusalOf(tx, context, target.id, target.data);
  if (refusal !== undefined) return refusal;
  const launched = await launchRun(tx, {
    taskId: target.id,
    agentActorId: String(target.data['agent']),
    personId: session.personId,
    actorId: session.actorId,
    subjects: subjectsOf(session),
  });
  if (!launched.ok) return refused(launched.refusal);
  return applied(target.id, target.revision, { runId: launched.launchId, state: 'waiting' });
}
