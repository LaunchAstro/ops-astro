// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody files a subscription in one form only (#1620): the owner's own
// refreshable sign-in, named by its token file and the sign-in destination
// that refreshes it, with no value of its own. A subscription pasted as a
// value stays unstorable, and the refreshable form is a subscription only.

import { expect, it } from 'vitest';
import { described, parseCredentials } from '../../packages/core-custody/src/index.ts';

const signIn = {
  ref: 'chatgpt_plan',
  kind: 'subscription',
  account: 'owner-plan',
  destination: 'chatgpt_plan',
  scheme: 'oauth_refresh',
  tokenFile: '/var/lib/ops-astro/chatgpt-plan.json',
  refreshDestination: 'chatgpt_sign_in',
};

it("the owner's refreshable sign-in is filed as a subscription with no value", () => {
  const read = parseCredentials([signIn]);
  expect(read.ok).toBe(true);
  const held = read.ok ? read.credentials.get('chatgpt_plan') : undefined;
  expect(held).toMatchObject({
    kind: 'subscription',
    scheme: 'oauth_refresh',
    header: 'authorization',
    value: '',
    tokenFile: signIn.tokenFile,
    refreshDestination: 'chatgpt_sign_in',
  });
  expect(described(held, 'chatgpt_plan')).toEqual({
    type: 'described',
    kind: 'subscription',
    account: 'owner-plan',
    presents: true,
  });
});

it('a subscription pasted as a value stays unstorable', () => {
  const pasted = {
    ...signIn,
    scheme: 'bearer',
    header: 'authorization',
    value: 'eyJ-pasted-token',
  };
  expect(parseCredentials([pasted])).toEqual({
    ok: false,
    code: 'CREDENTIAL_NOT_STORABLE',
    at: 0,
  });
});

it.each([
  ['it carries a value', { ...signIn, value: 'eyJ-pasted-token' }],
  ['it names a header', { ...signIn, header: 'authorization' }],
  ['it is filed as an API key', { ...signIn, kind: 'api_key' }],
  ['its token file is not a whole path', { ...signIn, tokenFile: 'chatgpt-plan.json' }],
  ['it names no refresh destination', { ...signIn, refreshDestination: undefined }],
  ['it has no account', { ...signIn, account: '' }],
])('the refreshable form is refused when %s', (_why, entry) => {
  expect(parseCredentials([entry])).toEqual({ ok: false, code: 'CREDENTIAL_MALFORMED', at: 0 });
});
