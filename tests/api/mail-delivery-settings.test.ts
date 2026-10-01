// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b's delivery worker at the entry: `MAIL_DELIVERY` is off unless set to
// `mock`, the one value there is while no provider account exists; mock with
// a setting missing or malformed stops the server, naming the setting and
// never its value; the made-up email choices say they are made up.

import { expect, it } from 'vitest';
import {
  MAIL_DELIVERY_SETTINGS,
  mailDeliverySettings,
  MOCK_PREFERENCES,
} from '../../apps/api/mail-delivery.ts';

// Addresses are built from their domains: no address is written whole in the repository.
const SENDING = 'send.example.test';
const SECRET_HOST = 'secret-host.test';

const mock = {
  MAIL_DELIVERY: 'mock',
  MAIL_PROVIDER_ORIGIN: 'http://127.0.0.1:9',
  MAIL_CREDENTIALS_FILE: '/nowhere/credentials.json',
  MAIL_APP_ORIGIN: 'https://ops.example.test',
  MAIL_FROM: `hello@${SENDING}`,
};

it('AW-07b mail delivery: off unless set, mock with every setting, anything else refused', () => {
  expect(mailDeliverySettings({})).toEqual({ kind: 'off' });
  expect(mailDeliverySettings({ MAIL_DELIVERY: 'off' })).toEqual({ kind: 'off' });
  expect(mailDeliverySettings(mock)).toMatchObject({
    kind: 'mock',
    destination: { key: 'email', origin: 'http://127.0.0.1:9' },
    appOrigin: 'https://ops.example.test',
    from: `hello@${SENDING}`,
    subdomain: 'send.example.test',
  });
  expect(MOCK_PREFERENCES.mock).toBe(true);
  for (const toggle of ['on', 'resend', 'MOCK']) {
    const refused = mailDeliverySettings({ ...mock, MAIL_DELIVERY: toggle });
    expect(refused).toMatchObject({ kind: 'invalid' });
    expect(JSON.stringify(refused)).toContain('MAIL_DELIVERY');
  }
});

it('AW-07b mail delivery: a setting missing or malformed is named, never its value', () => {
  for (const name of MAIL_DELIVERY_SETTINGS) {
    const missing = mailDeliverySettings({ ...mock, [name]: '' });
    expect(missing).toMatchObject({ kind: 'invalid' });
    expect(JSON.stringify(missing)).toContain(name);
  }
  const malformed: readonly (readonly [string, string])[] = [
    ['MAIL_PROVIDER_ORIGIN', 'http://mail.secret-host.test'],
    ['MAIL_PROVIDER_ORIGIN', 'https://mail.secret-host.test/emails'],
    ['MAIL_APP_ORIGIN', 'http://ops.secret-host.test'],
    ['MAIL_FROM', `hello@${SECRET_HOST}`],
    ['MAIL_FROM', 'not-an-address'],
  ];
  for (const [name, value] of malformed) {
    const refused = mailDeliverySettings({ ...mock, [name]: value });
    expect(refused, value).toMatchObject({ kind: 'invalid' });
    expect(JSON.stringify(refused)).toContain(name);
    expect(JSON.stringify(refused)).not.toContain('secret-host');
  }
});

it('AW-07b mail delivery: mock reaches only a provider on this machine, never a real one', () => {
  for (const origin of ['https://api.resend.com', 'https://outbox.secret-host.test']) {
    const refused = mailDeliverySettings({ ...mock, MAIL_PROVIDER_ORIGIN: origin });
    expect(refused, origin).toMatchObject({ kind: 'invalid' });
    expect(JSON.stringify(refused)).toContain('MAIL_PROVIDER_ORIGIN');
    expect(JSON.stringify(refused)).not.toContain('secret-host');
  }
  for (const origin of ['http://127.0.0.1:9', 'https://127.0.0.1:8443']) {
    expect(mailDeliverySettings({ ...mock, MAIL_PROVIDER_ORIGIN: origin }), origin).toMatchObject({
      kind: 'mock',
    });
  }
});
