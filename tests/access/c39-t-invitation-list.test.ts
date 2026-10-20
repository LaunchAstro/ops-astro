// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3B: `invitation.list`, the read Settings ▸ Access lists the
// invitations from. A person holding `access:share` on the business lists
// that business's invitations, each with its name, address, role, state
// (expired derived from its lifetime) and its sent and expiry times; another
// business's are never listed or counted. Without the key, with it on one
// client only, or as an agent, the read is refused. No token and no token
// hash reaches the answer (the canary).

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { insertAgentActor, insertAgentMapping, insertLogin } from '../identity/fixture.ts';
import type { Member } from '../commands/fixture.ts';
import {
  addressFor,
  as,
  c,
  invite,
  linkIn,
  noDatabase,
  send,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

interface Listed {
  readonly invitationId: string;
  readonly name: string;
  readonly address: string;
  readonly role: string;
  readonly state: string;
  readonly sentAt: string | null;
  readonly expiresAt: string;
}

const listAs = async (who: Member, business: string = w.alpha): Promise<unknown> =>
  await executeRead(w.db.app, business as never, who.presented, {
    read: 'invitation.list',
  } as never);

const rowsOf = (answer: unknown): readonly Listed[] => {
  expect(isCommandRefusal(answer as never), JSON.stringify(answer)).toBe(false);
  return (answer as { readonly invitations: readonly Listed[] }).invitations;
};

/** The token the last mail to an address carries. */
const tokenTo = (address: string): string =>
  linkIn(
    w.provider.received
      .map((message) => message.body)
      .findLast((body) => body.includes(JSON.stringify(address))),
  ).token;

/** One of each state in alpha, one whose send failed, and one pending in bravo. */
async function eachState() {
  w.provider.mode('accept');
  const address = addressFor('listed');
  const pending = await invite(c.admin, address);
  expect(await send(pending)).toMatchObject({ ok: true });
  // A send the provider answered badly is a failed attempt, not a sent one.
  w.provider.mode('malformed');
  const failed = await invite(c.admin, addressFor('failed'));
  expect(await send(failed)).toMatchObject({ ok: false });
  w.provider.mode('accept');
  const revoked = await invite(c.admin);
  expect(isCommandRefusal(await as(c.admin, 'invitation.revoke', { invitationId: revoked }))).toBe(
    false,
  );
  const lapsed = await invite(c.admin, addressFor('lapsed'), 'admin');
  await w.db.admin.execute(
    `update public.invitations set expires_at = now() - interval '1 minute' where id = $1`,
    [lapsed],
  );
  const bravos = await invite(c.bravoAdmin);
  return { address, pending, failed, revoked, lapsed, bravos, token: tokenTo(address) };
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T invitation list', () => {
  it('C39-T invitation list: a holder of access:share lists its business invitations, states derived, never a token', async () => {
    const made = await eachState();
    const listed = rowsOf(await listAs(c.second));
    const byId = new Map(listed.map((row) => [row.invitationId, row]));
    expect(byId.get(made.pending)).toMatchObject({
      name: 'Ivy Invitee',
      address: made.address,
      role: 'member',
      state: 'pending',
    });
    expect(typeof byId.get(made.pending)?.sentAt).toBe('string');
    expect(Date.parse(byId.get(made.pending)?.expiresAt ?? '')).toBeGreaterThan(Date.now());
    expect(byId.get(made.failed)).toMatchObject({ state: 'pending', sentAt: null });
    expect(byId.get(made.revoked)).toMatchObject({ state: 'revoked', sentAt: null });
    expect(byId.get(made.lapsed)).toMatchObject({ state: 'expired', role: 'admin' });

    // Business to business: bravo's is never listed or counted.
    expect(byId.has(made.bravos)).toBe(false);
    const [alpha] = await w.db.admin.execute<{ n: string }>(
      'select count(*)::text as n from public.invitations where business_id = $1',
      [w.alpha],
    );
    expect(listed).toHaveLength(Number(alpha?.n));
    const bravo = rowsOf(await listAs(c.bravoAdmin, w.bravo));
    expect(bravo.map((row) => row.invitationId)).toStrictEqual([made.bravos]);

    // The canary: neither the token nor any hash kept for it reaches the answer.
    const answer = JSON.stringify(listed);
    expect(answer).not.toContain(made.token);
    expect(answer).not.toContain(createHash('sha256').update(made.token).digest('hex'));
    const hashes = await w.db.admin.execute<{ token_hash: string }>(
      'select token_hash from public.enrolment_tokens',
    );
    expect(hashes.length).toBeGreaterThan(0);
    for (const { token_hash: hash } of hashes) expect(answer).not.toContain(hash);
  });

  it('C39-T invitation list refusals: no access:share, a client-scoped key and an agent are refused', async () => {
    await invite(c.admin);
    for (const who of [c.member, c.clientSharer]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await listAs(who)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    }
    const agent = await w.db.app.withBusiness(w.alpha, async (tx) => {
      const actor = await insertAgentActor(tx);
      const subject = `agent-${randomUUID()}`;
      await insertAgentMapping(tx, await insertLogin(tx, subject), actor, c.admin.actorId);
      return { provider: 'supabase' as const, subject };
    });
    const refused = await executeAgentCommand(w.db.app, w.alpha, agent, undefined, {
      command: 'invitation.list',
    } as never);
    expect(refused).toMatchObject({ code: 'DELEGATION_EXCLUDES_OPERATION' });
  });
});
