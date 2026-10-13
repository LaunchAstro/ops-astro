// SPDX-License-Identifier: AGPL-3.0-only
//
// A restore's admission (agent-login.ts). A restore puts back an agent this
// tool switched off, with a new provider user and a new login, one generation
// past the last; it never unbans the old user, whose sessions the provider
// keeps. It admits only when the agent's latest act is a stop whose ban is
// done or shared, the agent was active when stopped and has not been switched
// off again since, no credential of the agent was revoked after the stop, the
// owner's access has not ended since and the owner is still active. Its
// phases are make's (agent-login-phases.ts).

import { admitted, liveLogins, type Act, type Execute, type Run } from './agent-login-acting.ts';
import { generation, lockedActs, type Admission } from './agent-login-admission.ts';
import { Refusal } from './staging-reset.ts';

const NOT_OFF = 'the agent was not switched off by this tool, or was switched off again since';

/** Why the stop `last` cannot be put back, read under the locks restore holds; or nothing. */
async function notRestorable(
  execute: Execute,
  run: Run,
  last: Act | undefined,
  agent: { owner: string; deactivatedAt: Date | null },
): Promise<string | undefined> {
  if (last?.act !== 'stop') return NOT_OFF;
  if (last.ban === 'owed') return 'the stop still owes its ban: run stop again first';
  const stamp = last.actor_deactivated_at?.getTime();
  if (last.actor_was_active !== true || agent.deactivatedAt?.getTime() !== stamp) return NOT_OFF;
  const revoked = await execute(
    `select 1 from public.agent_credentials
      where business_id = $1 and agent_actor_id = $2 and revoked_at > $3`,
    [run.businessId, run.make.agentId, last.stopped_at],
  );
  if (revoked.length > 0) return "a credential of the agent's was revoked since the stop";
  const ended = await execute(
    'select 1 from public.access_endings where business_id = $1 and person_id = $2 and ended_at > $3',
    [run.businessId, agent.owner, last.stopped_at],
  );
  return ended.length > 0 ? "the owner's access ended since the stop" : undefined;
}

/** A restore's admission: already restored, its open act resumed, or the next generation. */
export async function restoreAdmission(execute: Execute, run: Run): Promise<Admission> {
  // The agent's credentials before the agent, as an access ending locks them.
  await execute(
    'select id from public.agent_credentials where business_id = $1 and agent_actor_id = $2 order by id for share',
    [run.businessId, run.make.agentId],
  );
  const agent = await admitted(execute, run, false);
  const live = await liveLogins(execute, run);
  const acts = await lockedActs(execute, run);
  const open = acts.find((act) => act.closed_at === null);
  const last = acts.at(-1);
  if (
    open === undefined &&
    last?.act === 'restore' &&
    live.length === 1 &&
    live[0] === last.login_id
  )
    return { already: last };
  if (open?.act !== 'restore') {
    const why = await notRestorable(execute, run, last, agent);
    if (why !== undefined) throw new Refusal(why);
  }
  const next = Math.max(0, ...acts.map((act) => act.generation ?? 0)) + 1;
  return await generation(execute, run, { name: agent.name, live, open, next });
}
