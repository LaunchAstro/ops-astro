// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T review follow-up: a link whose mail is still on its way when the
// invitation moves. The send mints its token and commits before the mail
// leaves (`broker-invitation.ts`), so a revoke or a resend can land while the
// message is at the mail provider. A revoked invitation's link is refused by
// both accepts, which require the invitation pending under its row lock at
// the bind. A resend spends every token minted before it at once, so the
// link in flight is dead whether or not the resend's own send ever comes. A
// token minted after the resend is live, whichever act's send mints it: a
// send that had not minted when the resend landed still mints a link that
// enrols (same address, the extended expiry).

import { describe, expect, it } from 'vitest';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import {
  bindVia,
  boundTo,
  e,
  enrolVia,
  heldInBravo,
  identityRows,
  invited,
  loginOf,
  spentOf,
  tokenTo,
  useEnrolWorld,
} from './c39-t-enrol-world.ts';
import { addressFor, as, c, codeOf, invite, MAIL, noDatabase, send, w } from './c39-t-world.ts';

useEnrolWorld();

const REFUSED = { status: 404, body: { code: 'ENROLMENT_LINK_INVALID' }, cookie: null };
const ENROLLED = { status: 200, body: { state: 'enrolled' }, cookie: null };

/** The broker, running `work` while the mail is at the provider, before custody sends it. */
function midSend(work: () => Promise<void>): Broker {
  const custody = w.broker.custody;
  return {
    ...w.broker,
    custody: {
      ...custody,
      dispatch: async (ref, request) => {
        await work();
        return await custody.dispatch(ref, request);
      },
    },
  };
}

/** Invite, then send while `work` runs mid-send: the invitation and the link it mailed. */
async function sentDuring(
  address: string,
  work: (id: string) => Promise<void>,
): Promise<{ id: string; token: string }> {
  w.provider.mode('accept');
  const id = await invite(c.admin, address);
  const sent = await sendInvitation(
    w.db.app,
    w.alpha,
    id,
    midSend(async () => await work(id)),
    MAIL,
  );
  expect(sent).toMatchObject({ ok: true, state: 'accepted' });
  return { id, token: tokenTo(address) };
}

const revoke = async (id: string): Promise<void> => {
  expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: id }))).toBe('applied');
};

const resend = async (id: string): Promise<void> => {
  expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: id }))).toBe('applied');
};

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T link in flight', () => {
  it('C39-T revoke in flight: a link mailed while its invitation was revoked is refused by the token-only and the signed-in accept, asks the provider nothing and binds nothing', async () => {
    e.users.mode('accept');
    const address = addressFor('revoked-in-flight');
    const login = await heldInBravo(address);
    const { id, token } = await sentDuring(address, revoke);
    const asked = e.users.received.length;
    const rows = await identityRows(w.alpha);
    expect(await enrolVia(token)).toStrictEqual(REFUSED);
    expect(await bindVia(token, loginOf(login))).toStrictEqual(REFUSED);
    expect(e.users.received).toHaveLength(asked);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
    expect(await boundTo(w.alpha, login)).toBeUndefined();
    expect(await spentOf(id)).toStrictEqual({ state: 'revoked', spent: 0, tokens: 1 });
  });

  it('C39-T revoke at the bind: a signed-in accept whose invitation is revoked while the provider reads its login binds nothing and spends nothing', async () => {
    const address = addressFor('revoked-at-bind');
    const login = await heldInBravo(address);
    const { id, token } = await invited(c.admin, address);
    const rows = await identityRows(w.alpha);
    // The link is live at the find; the revoke lands before the bind takes the row's lock.
    e.users.beforeNext(async () => {
      await revoke(id);
    });
    expect(await bindVia(token, loginOf(login))).toStrictEqual(REFUSED);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
    expect(await boundTo(w.alpha, login)).toBeUndefined();
    expect(await spentOf(id)).toStrictEqual({ state: 'revoked', spent: 0, tokens: 1 });
  });

  it('C39-T resend spends older links: a resend whose own send never comes still leaves the earlier link refused', async () => {
    e.users.mode('accept');
    const address = addressFor('resent-unsent');
    const { id, token } = await invited(c.admin, address);
    await resend(id);
    const rows = await identityRows(w.alpha);
    expect(await enrolVia(token)).toStrictEqual(REFUSED);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
    expect(await spentOf(id)).toStrictEqual({ state: 'pending', spent: 1, tokens: 1 });
    // The control: the resend's own send mints the one live link.
    expect(await send(id)).toMatchObject({ ok: true });
    expect(await enrolVia(tokenTo(address))).toStrictEqual(ENROLLED);
    expect(await spentOf(id)).toStrictEqual({ state: 'accepted', spent: 2, tokens: 2 });
  });

  it('C39-T resend spends older links: a resend whose own send never comes leaves the earlier link refused to the signed-in accept too, which binds nothing', async () => {
    e.users.mode('accept');
    const address = addressFor('resent-unsent-signed-in');
    const login = await heldInBravo(address);
    const { id, token } = await invited(c.admin, address);
    await resend(id);
    const rows = await identityRows(w.alpha);
    expect(await bindVia(token, loginOf(login))).toStrictEqual(REFUSED);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
    expect(await boundTo(w.alpha, login)).toBeUndefined();
    expect(await spentOf(id)).toStrictEqual({ state: 'pending', spent: 1, tokens: 1 });
  });

  it('C39-T resend spends older links: a send that mints after the resend landed mints a live link, which enrols', async () => {
    e.users.mode('accept');
    const address = addressFor('sent-after-resend');
    w.provider.mode('accept');
    const id = await invite(c.admin, address);
    // The create's send has not minted when the resend lands; it mints after it.
    await resend(id);
    expect(await spentOf(id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 0 });
    expect(await send(id)).toMatchObject({ ok: true });
    expect(await enrolVia(tokenTo(address))).toStrictEqual(ENROLLED);
    expect(await spentOf(id)).toStrictEqual({ state: 'accepted', spent: 1, tokens: 1 });
  });

  it('C39-T resend spends older links: a link mailed while its invitation was resent is refused, and the resend’s own link enrols', async () => {
    e.users.mode('accept');
    const address = addressFor('resent-in-flight');
    const { id, token } = await sentDuring(address, resend);
    expect(await spentOf(id)).toStrictEqual({ state: 'pending', spent: 1, tokens: 1 });
    expect(await enrolVia(token)).toStrictEqual(REFUSED);
    expect(await send(id)).toMatchObject({ ok: true });
    const newer = tokenTo(address);
    expect(newer).not.toBe(token);
    expect(await enrolVia(newer)).toStrictEqual(ENROLLED);
    expect(await spentOf(id)).toStrictEqual({ state: 'accepted', spent: 2, tokens: 2 });
  });
});
