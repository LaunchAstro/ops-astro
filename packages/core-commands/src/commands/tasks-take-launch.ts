// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.take_launch`: the launched agent, signed in as itself and holding
// nothing, takes its own launch (`authority/launch-take.ts`) and is handed the
// run's credential. It names the launch, or none for its own open one.
//
// Only the agent the launch is for takes it, on its login alone:
//
// - a person is refused `SCOPE_NOT_GRANTED`: a person launches, and the run
//   is the agent's;
// - a delegation credential is refused the same: the take is what hands one
//   over, so presenting one is asking with somebody's run in hand;
// - a launch of another agent's, or none by that id, is refused the same, in
//   the same words, so the answer tells nothing of another agent's runs.
//
// The answer names the launch and its task and, while it may run, the
// credential, which the register keeps as null (`agent-applied.ts`). A launch
// that can no longer run is answered `ended` with its cause and no credential.

import { takeLaunch } from '../../../core-records/src/index.ts';
import type { AgentCall, AgentRequest } from './agent-call.ts';
import { isIdentifier } from './operands.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';

const NOT_YOURS_FIX = 'Take only a launch made for you; ask with no launch named for your own.';

const notYours = (fix: string): HandlerOutcome =>
  refused(refuseCommand('SCOPE_NOT_GRANTED', ['launch'], [fix]));

/** A person's call: the run is the agent's to take. */
export const takeLaunchAsPerson = (): Promise<HandlerOutcome> =>
  Promise.resolve(notYours('Only the agent a launch is for takes it, signed in as itself.'));

export interface TakeOperands {
  /** The launch named, or undefined for the caller's own open one. */
  readonly launchId: string | undefined;
  /** A launch id sent that is no identifier: answered as one that is not the caller's. */
  readonly malformed: boolean;
}

export function takeLaunchOperands(request: AgentRequest): TakeOperands {
  const named = request['launchId'];
  if (named === undefined) return { launchId: undefined, malformed: false };
  return isIdentifier(named)
    ? { launchId: named, malformed: false }
    : { launchId: undefined, malformed: true };
}

export async function serveTakeLaunch(
  tx: Parameters<typeof takeLaunch>[0],
  { session, credential }: AgentCall,
  { launchId, malformed }: TakeOperands,
): Promise<HandlerOutcome> {
  if (credential !== undefined && credential !== '') {
    return notYours('Take a launch on your own login, presenting no credential.');
  }
  if (malformed) return notYours(NOT_YOURS_FIX);
  const taken = await takeLaunch(tx, session.actorId, launchId);
  switch (taken.kind) {
    case 'none':
      return applied(null, null, { state: 'none' });
    case 'not-yours':
      return notYours(NOT_YOURS_FIX);
    case 'no-key':
      return refused(
        refuseCommand(
          'DEPENDENCY_NOT_LANDED',
          ['task.take_launch', taken.why],
          [
            'This deployment does not hold the key this launch was minted under.',
            'Restore that key; the launch is unchanged and can be taken once it is back.',
          ],
        ),
      );
    case 'ended':
      return {
        ...applied(null, null, {
          launchId: taken.launchId,
          taskId: taken.taskId,
          state: 'ended',
          cause: taken.cause,
        }),
        auditSubjectId: taken.taskId,
      };
    case 'started':
      return {
        ...applied(null, null, {
          launchId: taken.launchId,
          taskId: taken.taskId,
          state: 'started',
          credential: taken.credential,
        }),
        auditSubjectId: taken.taskId,
      };
  }
}

/**
 * The take's row, which `AGENT_OPERATIONS` closes with `row`. Typed by its own
 * fields rather than the table's row type, so this file does not import the
 * table that imports it.
 */
export const TAKE_LAUNCH_ROW: {
  readonly authority: 'beforePickup';
  readonly replay: 'takeLaunch';
  readonly operands: typeof takeLaunchOperands;
  readonly serve: typeof serveTakeLaunch;
} = {
  authority: 'beforePickup',
  // On replay, served again for the launch it first named, as that launch
  // stands now (`replayTake`); the stored answer keeps no credential.
  replay: 'takeLaunch',
  operands: takeLaunchOperands,
  serve: serveTakeLaunch,
};
