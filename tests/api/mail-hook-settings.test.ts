// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b hook signature: the hook secret's one setting, `EMAIL_HOOK_SECRET`,
// read by `main` before the port is bound. Unset, the hook route is not
// mounted; set in any form but the provider's, the server stops naming the
// setting and never the value; set well, the route mounts with it.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { EMAIL_HOOK_SECRET_SETTING, mailHookSettings } from '../../apps/api/mail-hook.ts';

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
