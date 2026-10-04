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

it("the credentials checked for an agent's observation include its login credential", async () => {
  const { fixture } = r;
  const keys = configuredCredentialKeys();
  if (!keys.ok) throw new Error('no delegation credential keyring');
  const created = await asPerson('task.create', {
    operationId: randomUUID(),
    fields: { title: `receipt login ${randomUUID()}` },
  });
  const expiresAt = new Date(Date.now() + 3_600_000);
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    const login = await issueAgentCredential(tx, keys.keys, {
      personId: fixture.member.personId,
      actorId: fixture.member.actorId,
      purpose: `rcpt_${randomUUID().slice(0, 8)}`,
      scope: [{ collection: 'task', action: 'read' }],
      expiresAt,
    });
    const minted = await mintDelegation(tx, {
      agentActorId: login.agentActorId,
      delegatePersonId: fixture.member.personId,
      mintedByActorId: fixture.member.actorId,
      purpose: `rcpt_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read'],
      purposeScope: { kind: 'record', id: String(created.body['recordId']) },
      expiresAt,
    });
    if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
    const held = (await agentCredentials(tx, minted.value.delegation.id)) ?? [];
    expect([held.includes(login.credential), held.includes(minted.value.credential)]).toEqual([
      true,
      true,
    ]);
  });
});
