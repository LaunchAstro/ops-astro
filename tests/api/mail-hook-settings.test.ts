// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b hook signature: the hook secret's one setting, `EMAIL_HOOK_SECRET`,
// read by `main` before the port is bound. Unset, the hook route is not
// mounted; set in any form but the provider's, the server stops naming the
// setting and never the value; set well, the route mounts with it, and
// `composeApi`, the composition the server listens with, serves it.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  EMAIL_HOOK_SECRET_SETTING,
  MAIL_HOOK_PATH,
  mailHookSettings,
  type MailHookOptions,
} from '../../apps/api/mail-hook.ts';
import { composeApi } from '../../apps/api/server.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { staticKeySet, TEST_ISSUER, TEST_KEY_SET_URL } from '../support/sign-in.ts';

const secret = `whsec_${randomBytes(24).toString('base64')}`;

it('AW-07b hook signature: no hook secret set leaves the hook route unmounted', () => {
  expect(mailHookSettings({})).toEqual({ kind: 'absent' });
  expect(mailHookSettings({ [EMAIL_HOOK_SECRET_SETTING]: '' })).toEqual({ kind: 'absent' });
});

it('AW-07b hook signature: a secret not in the provider form stops the server, naming the setting and never the value', () => {
  for (const bad of ['whsec_short', 'not-a-secret-at-all-but-long-enough', `${secret} `]) {
    const settings = mailHookSettings({ [EMAIL_HOOK_SECRET_SETTING]: bad });
    expect(settings.kind).toBe('invalid');
    if (settings.kind !== 'invalid') continue;
    expect(settings.problem).toContain(EMAIL_HOOK_SECRET_SETTING);
    expect(settings.problem).not.toContain(bad.trim());
  }
});

it('AW-07b hook signature: a secret in the provider form mounts the hook with it', () => {
  expect(mailHookSettings({ [EMAIL_HOOK_SECRET_SETTING]: secret })).toEqual({
    kind: 'configured',
    secret,
  });
});

/** One unsigned POST to the hook path of a composed server, with or without the hook. */
const served = async (mailHook?: MailHookOptions): Promise<Response> =>
  await composeApi({
    database: {} as never,
    admin: {} as never,
    keys: runtimeKeys({}),
    signIn: { issuer: TEST_ISSUER, keySetUrl: TEST_KEY_SET_URL, fetch: staticKeySet },
    ...(mailHook === undefined ? {} : { mailHook }),
  }).app.fetch(
    new Request(`http://api.test${MAIL_HOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );

it('AW-07b hook signature: the composed server serves the hook route only when the hook is configured', async () => {
  // Unsigned, the mounted route refuses at the headers, before any business is asked.
  const mounted = await served({
    secret,
    businesses: async () => await Promise.reject(new Error('the hook asked for businesses')),
  });
  expect(mounted.status).toBe(401);
  expect(await mounted.json()).toEqual({ code: 'HOOK_HEADERS' });
  const absent = await served();
  expect(absent.status).toBe(404);
});
