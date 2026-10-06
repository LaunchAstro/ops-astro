// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T hook signature: the login provider's Send Email hook secret, one
// setting, `AUTH_EMAIL_HOOK_SECRET`, read in the provider's form
// (`v1,whsec_...`) only. A wrong value names the setting and never the value.
// No database: the hook's own cases run over one (`c39-t-auth-hook.test.ts`).

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { authEmailHookSettings } from '../../apps/api/auth-email-hook.ts';

/** A made-up hook secret in the login provider's form. Never a real credential. */
const secret = `v1,whsec_${randomBytes(24).toString('base64')}`;

it('C39-T hook signature: the secret is read in the login provider form only, and a wrong one names the setting, never its value', () => {
  expect(authEmailHookSettings({})).toStrictEqual({ kind: 'absent' });
  expect(authEmailHookSettings({ AUTH_EMAIL_HOOK_SECRET: secret })).toStrictEqual({
    kind: 'configured',
    secret: secret.slice('v1,'.length),
  });
  for (const wrong of [secret.slice(3), 'v1,whsec_short', 'v2,whsec_x', 'plain']) {
    const read = authEmailHookSettings({ AUTH_EMAIL_HOOK_SECRET: wrong });
    expect(read.kind, wrong).toBe('invalid');
    expect(JSON.stringify(read)).not.toContain(wrong);
  }
});
