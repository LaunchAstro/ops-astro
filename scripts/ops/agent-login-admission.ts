// SPDX-License-Identifier: AGPL-3.0-only
//
// A make's admission, and the generation rules a restore shares
// (agent-login-restore.ts), judged under the locks agent-login-acting.ts takes.

import {
  admitted,
  liveLogins,
  NOT_OURS,
  subjectFree,
  type Act,
  type Execute,
  type Run,
} from './agent-login-acting.ts';
import { Refusal } from './staging-reset.ts';

/** What admission decides: already made, resume the open act, or reserve a new generation. */
export type Admission =
  | { readonly already: Act }
  | { readonly open: Act }
  | {
      readonly fresh: {
        readonly email: string;
        readonly item: string;
        readonly generation: number;
      };
    };

/** The agent's acts, locked, oldest first. */
export async function lockedActs(execute: Execute, run: Run): Promise<readonly Act[]> {
  return await execute<Act>(
    `select * from ops.agent_login_acts where business_id = $1 and agent_actor_id = $2
      order by created_at for update`,
    [run.businessId, run.make.agentId],
  );
}

/**
 * Admission shared by make and restore: the open act of this kind resumed, or
 * generation `next`'s values. No live mapping but the open act's own, an
 * address no other act holds, and a stamped subject no business's login holds
 * but this act's.
 */
export async function generation(
  execute: Execute,
  run: Run,
  {
    name,
    live,
    open,
    next,
  }: { name: string; live: string[]; open?: Act | undefined; next: number },
): Promise<Admission> {
  if (open !== undefined && open.act !== run.make.act)
    throw new Refusal(`the agent's open ${open.act} act is not finished: run ${open.act} again`);
  const { local, domain, production } = run.make;
  const email = `${local}+g${open?.generation ?? next}@${domain}`;
  if (live.some((login) => login !== open?.login_id)) throw new Refusal(NOT_OURS);
  const taken = await execute(
    'select 1 from ops.agent_login_acts where lower(email) = lower($1) and id is distinct from $2',
    [email, open?.id ?? null],
  );
  if (taken.length > 0) throw new Refusal('the address is already used by another act');
  if (open !== undefined) {
    if (open.email !== email) throw new Refusal('--email is not the address of the open act');
    if (open.provider_subject !== null)
      await subjectFree(execute, open.provider_subject, open.login_id);
    return { open };
  }
  const environment = production ? 'Production' : 'Staging';
  const item = `Ops Astro ${environment} - ${name} Agent Sign-in g${next}`;
  return { fresh: { email, item, generation: next } };
}

/** A make's admission: already made when its make act's login is the one live mapping. */
export async function admission(execute: Execute, run: Run): Promise<Admission> {
  const { name } = await admitted(execute, run);
  const live = await liveLogins(execute, run);
  const acts = await lockedActs(execute, run);
  const open = acts.find((act) => act.closed_at === null);
  const made = acts.find((act) => act.act === 'make');
  if (open === undefined && made !== undefined) {
    if (live.length === 1 && live[0] === made.login_id) return { already: made };
    throw new Refusal('the agent was made already: a later login is a restore');
  }
  return await generation(execute, run, { name, live, open, next: 1 });
}
