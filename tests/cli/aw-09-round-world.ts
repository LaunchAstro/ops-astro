// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-09's three surfaces over the real served API: the app's own client
// (`OperationsClient`), the API's person and agent prefixes over HTTP, and the
// command line as its own process (T4b1's helper, `cli-process-harness.ts`).
// A person's step and an agent's step are each sent the leg's way, so a leg's
// facts are what that surface answered.
//
// The agent's output is real: Ada proposes and approves a plan, the agent
// picks the reservation up and hands it back with a successor on the leg's
// agent channel. That successor is the reviewed output (AW-08), and each
// revision after a request for changes is the agent's own `task.propose` on
// the lineage, under a delegation Ada's grants narrow (`proposal:write`).

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { DELEGATION_HEADER, pathOf, READS } from '../../packages/core-wire/src/surface.ts';
import type { CommandName } from '../../packages/core-wire/src/index.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { bearer, call, personPath, type World } from '../acceptance/world.ts';
import { runCli, type ServedApi } from './cli-process-harness.ts';

export type Leg = 'app' | 'api' | 'cli';
export const LEGS: readonly Leg[] = ['app', 'api', 'cli'];

export interface Said {
  readonly ok: boolean;
  readonly code: string | null;
  readonly body: Record<string, unknown>;
}

export interface Round {
  readonly world: World;
  readonly api: ServedApi;
  readonly scratch: string;
}

/** The agent's output on a task: the successor's gate, version and lineage. */
export interface Output {
  readonly taskId: string;
  readonly lineageId: string;
  readonly gateId: string;
  readonly versionId: string;
  /** A live delegation Ada's grants narrow, for the agent's revisions. */
  readonly delegation: string;
}

export const env = (
  r: Round,
  token: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  OPS_ASTRO_API_URL: r.api.origin,
  OPS_ASTRO_BUSINESS: 'alpha',
  OPS_ASTRO_TOKEN: token,
  OPS_ASTRO_TOKEN_FILE: join(r.scratch, `token-${randomUUID()}`),
  OPS_ASTRO_DELEGATION_FILE: join(r.scratch, `delegation-${randomUUID()}`),
  ...extra,
});

const said = (ok: boolean, json: unknown): Said => {
  const body = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  return { ok, code: typeof body['code'] === 'string' ? body['code'] : null, body };
};

const isRead = (name: CommandName): boolean => READS.includes(name);

/** A call with a bearer on the person prefix, the way the leg makes it. */
export async function asPerson(
  r: Round,
  leg: Leg,
  name: CommandName,
  body: Record<string, unknown>,
  token: string,
): Promise<Said> {
  if (leg === 'cli') {
    const run = await runCli([name, '--json', JSON.stringify(body)], env(r, token));
    return said(run.code === 0, run.json);
  }
  if (leg === 'app') {
    const client = new OperationsClient({
      origin: r.api.origin,
      businessKey: 'alpha',
      signedIn: true,
      fetch: async (url, init) =>
        await fetch(url, { ...init, headers: { ...init?.headers, ...bearer(token) } }),
    });
    const result = isRead(name)
      ? await client.read(name as never, body)
      : await client.mutate(name as never, body);
    return 'ok' in result ? said(true, result.value) : said(false, result);
  }
  const sent = isRead(name) ? body : { operationId: randomUUID(), ...body };
  const response = await fetch(`${r.api.origin}/api/b/alpha${pathOf(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(token) },
    body: JSON.stringify(sent),
  });
  return said(response.ok, await response.json());
}

/**
 * The agent's own login on the agent prefix. The app hosts no agent, so its
 * leg sends what the API leg sends; the command line runs with `--agent`.
 */
export async function asAgent(
  r: Round,
  leg: Leg,
  name: CommandName,
  body: Record<string, unknown>,
  delegation?: string,
  extra: Readonly<Record<string, string>> = {},
): Promise<Said> {
  const token = r.world.agent.token;
  if (leg === 'cli') {
    const held = delegation === undefined ? {} : { OPS_ASTRO_DELEGATION: delegation };
    const run = await runCli(
      [name, '--agent', '--json', JSON.stringify(body)],
      env(r, token, { ...held, ...extra }),
    );
    return said(run.code === 0, run.json);
  }
  const response = await fetch(`${r.api.origin}/api/a/b/alpha${pathOf(name)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...bearer(token),
      ...(delegation === undefined ? {} : { [DELEGATION_HEADER]: delegation }),
    },
    body: JSON.stringify({ operationId: randomUUID(), ...body }),
  });
  return said(response.ok, await response.json());
}

const detail = (one: { body: Record<string, unknown> }, what: string): Record<string, unknown> => {
  const found = one.body['detail'];
  if (typeof found !== 'object' || found === null) {
    throw new Error(`${what}: no detail in ${JSON.stringify(one.body)}`);
  }
  return found as Record<string, unknown>;
};

export const PLAN = {
  purpose: 'draft_the_reply',
  maximumMinor: 3_000,
  currency: 'AUD',
  payload: { instruction: 'draft a reply' },
  step: { kind: 'compose', payload: {} },
} as const;

/** Ada's plan, approved by Ada (set up in-process: the leg is the agent's and the reviewer's). */
async function approvedPlan(r: Round, title: string) {
  const ada = bearer(r.world.ada.token);
  const task = await call(
    r.world.api,
    personPath('alpha', '/task/create'),
    { operationId: randomUUID(), fields: { title } },
    ada,
  );
  const taskId = String(task.body['recordId']);
  const proposed = await call(
    r.world.api,
    personPath('alpha', '/task/propose'),
    {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: task.body['revision'],
      ...PLAN,
    },
    ada,
  );
  const plan = detail(proposed, 'plan');
  const approved = await call(
    r.world.api,
    personPath('alpha', '/task/decide'),
    {
      operationId: randomUUID(),
      gateId: plan['gateId'],
      versionId: plan['versionId'],
      decision: 'approve',
      note: 'the plan',
    },
    ada,
  );
  return { taskId, reservationId: detail(approved, 'approve')['reservationId'] };
}

/** A delegation for the agent's revisions on `taskId`, narrowed from Ada's grants. */
export async function revisionDelegation(r: Round, taskId: string): Promise<string> {
  return await r.world.db.app.withBusiness(r.world.alpha, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: r.world.agent.actorId,
      delegatePersonId: r.world.ada.personId as string,
      mintedByActorId: r.world.ada.actorId as string,
      purpose: `aw09_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'comment', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
}

/** The agent picks up Ada's approved plan and hands back its output, on the leg's agent channel. */
export async function agentOutput(r: Round, leg: Leg, title: string): Promise<Output> {
  const { taskId, reservationId } = await approvedPlan(r, title);
  const file = join(r.scratch, `held-${randomUUID()}`);
  const held = { OPS_ASTRO_DELEGATION_FILE: file };
  const picked = await asAgent(r, leg, 'task.pickup', { reservationId }, undefined, held);
  const lease = detail(picked, 'pickup');
  // The command line saved the credential to its file and sends it from there.
  const credential = leg === 'cli' ? undefined : String(lease['credential']);
  const handedBack = await asAgent(
    r,
    leg,
    'task.handback',
    {
      leaseId: lease['leaseId'],
      fence: lease['fence'],
      outcome: 'completed',
      report: { wrote: 'a draft for review' },
      successor: { ...PLAN, payload: { instruction: 'the draft, for review' } },
    },
    credential,
    held,
  );
  const out = detail(handedBack, 'handback');
  const lineage = await r.world.db.admin.execute<{ readonly lineage_id: string }>(
    `select lineage_id from public.gates where business_id = $1 and id = $2`,
    [r.world.alpha, out['successorGateId']],
  );
  return {
    taskId,
    lineageId: String(lineage[0]?.lineage_id),
    gateId: String(out['successorGateId']),
    versionId: String(out['successorVersionId']),
    delegation: await revisionDelegation(r, taskId),
  };
}

/** The agent's next version on the lineage, after a request for changes. */
export async function revise(
  r: Round,
  leg: Leg,
  output: Output,
  maximumMinor: number = PLAN.maximumMinor,
): Promise<Said> {
  const revision = await r.world.db.admin.execute<{ readonly revision: number }>(
    `select revision::int as revision from public.records where business_id = $1 and id = $2`,
    [r.world.alpha, output.taskId],
  );
  return await asAgent(
    r,
    leg,
    'task.propose',
    {
      recordId: output.taskId,
      expectedRevision: revision[0]?.revision,
      lineageId: output.lineageId,
      ...PLAN,
      maximumMinor,
      payload: { instruction: `revised ${randomUUID().slice(0, 8)}` },
    },
    output.delegation,
  );
}

export const versionOf = (one: Said): { gateId: string; versionId: string } => {
  const found = detail(one, 'propose');
  return { gateId: String(found['gateId']), versionId: String(found['versionId']) };
};

export const decision = (
  at: { readonly gateId: string; readonly versionId: string },
  kind: string,
): Record<string, unknown> => ({
  gateId: at.gateId,
  versionId: at.versionId,
  decision: kind,
  note: `aw-09 ${kind}`,
});
