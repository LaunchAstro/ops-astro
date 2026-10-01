// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T's agent parity (CS-15.18) for a team invitation: `invitation.create`,
// `invitation.resend` and `invitation.revoke`, and the read `invitation.list`,
// each sent through the CLI
// client and straight to the person API as the same caller (`cli-parity.ts`).
// One invitation is made, resent and revoked through each surface, and the
// answers are the same record bar the values minted per call. The refusals
// are the same word for word: without `access:share`, the agent prefix, and
// another business by prefix and by id. No refusal writes an invitation, a
// person or a token, in either business.
//
// The world is C32's (`c32-clients-world.ts`): Ada is alpha's administrator
// and holds `access:share`, Mia holds the task keys alone, and Bea is bravo's,
// given `access:share` there below.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { harness, member, useClientsWorld } from '../authority/c32-clients-world.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { both, oneEach, refusedAlike, refusedSame, sameRecord, type Pair } from './cli-parity.ts';

useClientsWorld();

// Minted per call: the ids. The states and revisions are compared.
const MINTED = new Set(['recordId', 'operationId', 'invitationId']);

/** A unique address under the test domain, from the name with its spaces dropped. */
const addressFor = (name: string): string =>
  `${name.toLowerCase().replaceAll(' ', '-')}-${randomUUID().slice(0, 8)}@example.test`;

const invitation = (name: string) => ({ name, email: addressFor(name), role: 'member' });

const idOf = (answer: unknown): string =>
  String((answer as { readonly detail: { readonly invitationId: unknown } }).detail.invitationId);

/** Every row an invitation act could write in a business, to show a refusal wrote nothing. */
const invitationRows = async (businessId: string): Promise<readonly { readonly row: string }[]> =>
  await harness.world.db.app.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly row: string }>(
        `select to_jsonb(i)::text as row from public.invitations i
         union all select to_jsonb(t)::text from public.enrolment_tokens t
         union all select to_jsonb(p)::text from public.people p
         order by 1`,
      ),
  );

const stateOf = async (id: string): Promise<string | undefined> => {
  const [row] = await harness.world.db.admin.execute<{ state: string }>(
    'select state from public.invitations where id = $1',
    [id],
  );
  return row?.state;
};

/** Each surface acts on its own invitation, and both answer the same record. */
async function eachActs(verb: string, ids: { cli: string; api: string }): Promise<Pair> {
  const bodies = { cli: { invitationId: ids.cli }, api: { invitationId: ids.api } };
  const pair = await oneEach(harness.world.api, verb, bodies, harness.world.ada.token);
  sameRecord(pair, MINTED);
  return pair;
}

const VERBS_ON_ONE = ['invitation.resend', 'invitation.revoke'] as const;
const CREATE = invitation('Never Made');

/** Without `access:share`: each of the three, refused alike. */
async function refusedWithoutShare(alphaId: string): Promise<void> {
  const { world } = harness;
  const create = await both(world.api, 'invitation.create', CREATE, world.mia.token);
  refusedAlike(create, 403, 'SCOPE_NOT_GRANTED');
  const list = await both(world.api, 'invitation.list', {}, world.mia.token);
  refusedAlike(list, 403, 'SCOPE_NOT_GRANTED');
  for (const verb of VERBS_ON_ONE) {
    // eslint-disable-next-line no-await-in-loop
    const pair = await both(world.api, verb, { invitationId: alphaId }, world.mia.token);
    refusedAlike(pair, 403, 'SCOPE_NOT_GRANTED');
  }
}

/** The agent prefix: never an agent's, for any of the three. */
async function refusedOnAgentPrefix(alphaId: string): Promise<void> {
  const { world } = harness;
  const agent = { entry: 'agent' as const };
  refusedSame(await both(world.api, 'invitation.create', CREATE, world.agent.token, agent));
  refusedSame(await both(world.api, 'invitation.list', {}, world.agent.token, agent));
  for (const verb of VERBS_ON_ONE) {
    // eslint-disable-next-line no-await-in-loop
    refusedSame(await both(world.api, verb, { invitationId: alphaId }, world.agent.token, agent));
  }
}

/** Bravo's invitation by id through alpha, alpha's through bravo, and Ada on bravo's prefix. */
async function refusedAcrossBusinesses(alphaId: string, bravoId: string): Promise<void> {
  const { world } = harness;
  const bravo = { businessKey: 'bravo' };
  for (const verb of VERBS_ON_ONE) {
    /* eslint-disable no-await-in-loop */
    refusedSame(await both(world.api, verb, { invitationId: bravoId }, world.ada.token));
    refusedSame(await both(world.api, verb, { invitationId: alphaId }, world.bea.token, bravo));
    refusedSame(await both(world.api, verb, { invitationId: alphaId }, world.ada.token, bravo));
    /* eslint-enable no-await-in-loop */
  }
  refusedSame(await both(world.api, 'invitation.create', CREATE, world.ada.token, bravo));
}

/** One pending invitation in each business, made by its own administrator. */
async function onePendingEach(): Promise<{ readonly alphaId: string; readonly bravoId: string }> {
  const { world } = harness;
  const alpha = await both(world.api, 'invitation.create', invitation('Kept'), world.ada.token);
  const bravo = await both(world.api, 'invitation.create', invitation('Bo'), world.bea.token, {
    businessKey: 'bravo',
  });
  expect(bravo.cli.status, 'bravo invites in bravo').toBe(200);
  return { alphaId: idOf(alpha.cli.body), bravoId: idOf(bravo.cli.body) };
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('C39-T invitations on the command line', () => {
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    const { world } = harness;
    await world.db.app.withBusiness(world.bravo, async (tx) => {
      await grantTo(tx, member(world.bea), 'share', WHOLE_BUSINESS, false, 'access');
    });
  });

  it('C39-T parity: the CLI and the person API create, resend and revoke an invitation alike', async () => {
    const { world } = harness;
    const bodies = { cli: invitation('Cy Cli'), api: invitation('Abe Api') };
    const created = await oneEach(world.api, 'invitation.create', bodies, world.ada.token);
    expect(created.cli.status, JSON.stringify(created.cli.body)).toBe(200);
    sameRecord(created, MINTED);
    const ids = { cli: idOf(created.cli.body), api: idOf(created.api.body) };
    expect(ids.cli).not.toBe(ids.api);
    expect(await stateOf(ids.cli)).toBe('pending');
    expect(await stateOf(ids.api)).toBe('pending');

    await eachActs('invitation.resend', ids);
    expect(await stateOf(ids.cli)).toBe('pending');
    const revoked = await eachActs('invitation.revoke', ids);
    expect((revoked.cli.body as { detail: { state: string } }).detail.state).toBe('revoked');
    expect(await stateOf(ids.cli)).toBe('revoked');
    expect(await stateOf(ids.api)).toBe('revoked');
    // The list reads the same on both, each revoked invitation in it.
    const listed = await both(world.api, 'invitation.list', {}, world.ada.token);
    sameRecord(listed, MINTED);
    const states = (listed.cli.body as { invitations: { invitationId: string; state: string }[] })
      .invitations;
    expect(states.find((row) => row.invitationId === ids.cli)?.state).toBe('revoked');
  });

  it('C39-T parity refusals: no access:share, the agent prefix and another business, alike on both', async () => {
    const { world } = harness;
    const { alphaId, bravoId } = await onePendingEach();
    const rows = async () => ({
      alpha: await invitationRows(world.alpha),
      bravo: await invitationRows(world.bravo),
    });
    const before = await rows();
    await refusedWithoutShare(alphaId);
    await refusedOnAgentPrefix(alphaId);
    await refusedAcrossBusinesses(alphaId, bravoId);
    expect(await rows(), 'no refusal wrote an invitation, a token or a person').toStrictEqual(
      before,
    );
    expect(await stateOf(alphaId)).toBe('pending');
    expect(await stateOf(bravoId)).toBe('pending');
  });
});
