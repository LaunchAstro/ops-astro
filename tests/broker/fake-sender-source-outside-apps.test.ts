// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b sender: the fake sending-domain source is for tests and staging
// stands only. One app file reaches it, the API's mail delivery in its mock
// mode (`apps/api/mail-delivery.ts`), and no other: a running installation's
// setup check is otherwise never drawn from made-up records. Even there a mock
// report sends only over the custody core-custody started for a provider on
// this machine (`startLoopbackMockCustody`); the send refuses it over any other
// (tests/broker/aw-07b-mock-loopback-gate.test.ts, tests/api/mail-delivery-settings.test.ts).

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const apps = resolve(import.meta.dirname, '../../apps');
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;

/** The one app file allowed the fake source: mail delivery's mock mode, loopback only. */
const ALLOWED = ['api/mail-delivery.ts'];

it('AW-07b sender: nothing under apps/ but mock mail delivery imports the fake sender source', () => {
  const files = readdirSync(apps, { recursive: true, encoding: 'utf8' }).filter(
    (path) => SOURCE.test(path) && !/(?:^|\/)(?:node_modules|dist)\//u.test(path),
  );
  expect(files.length).toBeGreaterThan(0);
  const reaching = files.filter((path) =>
    /fakeSenderSource|email-sender-fake/u.test(readFileSync(join(apps, path), 'utf8')),
  );
  expect(reaching).toEqual(ALLOWED);
});
