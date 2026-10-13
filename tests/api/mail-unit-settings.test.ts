// SPDX-License-Identifier: AGPL-3.0-only
//
// The M5 mail unit's own settings, before any mail setting is read. Off, it
// starts nothing. On, it needs its own database login, the lookup login that
// reads business ids and keys alone, and the deployment's business keys. It
// never holds a login or key that belongs elsewhere: the admin login, the
// error sink's key, the sign-in provider's admin key or a backup credential
// stops it, naming the setting and never its value.

import { expect, it } from 'vitest';
import { mailUnitSettings } from '../../apps/mail/settings.ts';

// Built from parts: no login URL is written whole in the repository.
const login = (user: string): string =>
  `postgres://${user}:secret-pass${String.fromCodePoint(64)}db.example.test:6543/postgres`;

const on = {
  MAIL_DELIVERY: 'resend',
  DATABASE_MAIL_URL: login('mail'),
  DATABASE_LOOKUP_URL: login('lookup'),
  RECOVERY_BUSINESS_KEYS: 'agencyastro',
};

it('off starts nothing, whatever else is set', () => {
  expect(mailUnitSettings({})).toEqual({ ok: true, kind: 'off' });
  expect(mailUnitSettings({ MAIL_DELIVERY: 'off', DATABASE_ADMIN_URL: 'x' })).toEqual({
    ok: true,
    kind: 'off',
  });
});

it('on, it takes its own login, the lookup login and the business keys', () => {
  expect(mailUnitSettings(on)).toEqual({
    ok: true,
    kind: 'on',
    databaseUrl: on.DATABASE_MAIL_URL,
    lookupUrl: on.DATABASE_LOOKUP_URL,
    keys: ['agencyastro'],
  });
  expect(mailUnitSettings({ ...on, MAIL_DELIVERY: 'mock' })).toMatchObject({ kind: 'on' });
  for (const name of ['DATABASE_MAIL_URL', 'DATABASE_LOOKUP_URL', 'RECOVERY_BUSINESS_KEYS']) {
    const missing = mailUnitSettings({ ...on, [name]: '' });
    expect(missing, name).toMatchObject({ ok: false });
    expect(JSON.stringify(missing)).toContain(name);
    expect(JSON.stringify(missing)).not.toContain('secret-pass');
  }
});

it('a login or key held elsewhere stops it, named and never shown', () => {
  for (const name of [
    'DATABASE_ADMIN_URL',
    'SUPABASE_SERVICE_KEY',
    'OPS_ERROR_SINK_DSN',
    'BACKUP_STORE_URL',
  ]) {
    const refused = mailUnitSettings({ ...on, [name]: 'secret-held-value' });
    expect(refused, name).toMatchObject({ ok: false });
    expect(JSON.stringify(refused)).toContain(name);
    expect(JSON.stringify(refused)).not.toContain('secret-held-value');
  }
});
