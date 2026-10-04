// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08: a provider answer that re-spells a credential the observing agent
// holds (standard base64, split by a separator) is recorded absent, stored
// nowhere and shown on no receipt, through the real worker, observe and
// task.receipt; and the credentials checked include the agent's login.
// Assertions compare booleans, so a failure prints no credential.
import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  configuredCredentialKeys,
  issueAgentCredential,
  mintDelegation,
} from '../../packages/core-records/src/index.ts';
import { agentCredentials } from '../../packages/core-runtime/src/receipt-link.ts';
import {
  asPerson,
  attempts,
  HOST,
  launched,
  linking,
  noDatabase,
  r,
  useReceiptWorld,
  workerOn,
} from './aw-08-receipt-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useReceiptWorld('rcptrespelled');

/** The credential in standard base64, split by a dot: no 43-character run left. */
const respelled = (credential: string): string => {
  const standard = Buffer.from(credential, 'base64url').toString('base64');
  return `https://${HOST}/effects/${standard.slice(0, 22)}.${standard.slice(22)}`;
};

it("a provider receipt re-spelling the agent's purpose delegation credential is stored and shown as no link", async () => {
  const { taskId, credential } = await launched();
  const outcome = await workerOn(credential, linking(respelled(credential))).applyOnce(taskId);
  if (!('applied' in outcome)) throw new Error('the synthetic effect did not apply');
  const answer = await asPerson('task.receipt', { attemptId: outcome.applied.attemptId });
  const receipt = answer.body['receipt'] as Record<string, unknown> | undefined;
  const stored = await attempts(taskId);
  expect({
    status: answer.status,
    settled: (receipt?.['settlement'] as { state?: string } | undefined)?.state === 'settled',
    shown: receipt?.['link'] === null,
    observed: stored.map((row) => row['observed'] === true && row['link'] === null),
  }).toEqual({ status: 200, settled: true, shown: true, observed: [true] });
});

/** An agent with a login credential, a delegation under it, and a second agent to help. */
async function agentWithDelegation() {
  const { fixture } = r;
  const keys = configuredCredentialKeys();
  if (!keys.ok) throw new Error('no delegation credential keyring');
  const created = await asPerson('task.create', {
    operationId: randomUUID(),
    fields: { title: `receipt login ${randomUUID()}` },
  });
  const expiresAt = new Date(Date.now() + 3_600_000);
  return await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    const issue = async (until: Date) =>
      await issueAgentCredential(tx, keys.keys, {
        personId: fixture.member.personId,
        actorId: fixture.member.actorId,
        purpose: `rcpt_${randomUUID().slice(0, 8)}`,
        scope: [{ collection: 'task', action: 'read' }],
        expiresAt: until,
      });
    // The login lives four seconds, so the case can watch it expire; credentials are written once.
    const login = await issue(new Date(Date.now() + 4_000));
    const minted = await mintDelegation(tx, {
      agentActorId: login.agentActorId,
      delegatePersonId: fixture.member.personId,
      mintedByActorId: fixture.member.actorId,
      purpose: `rcpt_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'comment'],
      purposeScope: { kind: 'record', id: String(created.body['recordId']) },
      expiresAt,
    });
    if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
    return { keys: keys.keys, login, helper: await issue(expiresAt), minted: minted.value };
  });
}

/** A child the delegation minted for a helper: the parent's row under the helper's actor, reading only. */
async function childOf(
  parentId: string,
  helperActorId: string,
  keyId: string | null = null,
): Promise<string> {
  const childId = randomUUID();
  await r.fixture.db.admin.execute(
    `insert into public.delegations
       select (jsonb_populate_record(d, jsonb_build_object(
                 'id', $2::uuid, 'agent_actor_id', $3::uuid,
                 'parent_delegation_id', d.id, 'purpose', 'rcpt_child_' || $2::text,
                 'actions', jsonb_build_array('read'),
                 'credential_key_id', coalesce($4, d.credential_key_id)))).*
         from public.delegations d where d.id = $1`,
    [parentId, childId, helperActorId, keyId],
  );
  return childId;
}

const heldBy = async (delegationId: string) =>
  await r.fixture.db.app.withBusiness(
    r.fixture.business,
    async (tx) => await agentCredentials(tx, delegationId),
  );

it("the credentials checked for an agent's observation are its unexpired login, delegations and their children, and none when one cannot be derived", async () => {
  const { keys, login, helper, minted } = await agentWithDelegation();
  const childId = await childOf(minted.delegation.id, helper.agentActorId);
  const child = keys.derive(keys.activeKeyId, {
    businessId: r.fixture.business,
    agentActorId: helper.agentActorId,
    delegationId: childId,
  });
  const held = (await heldBy(minted.delegation.id)) ?? [];
  await expect
    .poll(async () => ((await heldBy(minted.delegation.id)) ?? []).includes(login.credential), {
      timeout: 10_000,
      interval: 500,
    })
    .toBe(false);
  await childOf(minted.delegation.id, helper.agentActorId, 'no-such-key');
  expect({
    login: held.includes(login.credential),
    delegation: held.includes(minted.credential),
    child: child !== undefined && held.includes(child),
    underivable: (await heldBy(minted.delegation.id)) === undefined,
  }).toEqual({
    login: true,
    delegation: true,
    child: true,
    underivable: true,
  });
});
