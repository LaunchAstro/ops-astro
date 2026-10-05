// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b sender: the fake sending-domain source is for tests and staging
// stands only. No app reaches it, so a running installation's setup check is
// never drawn from made-up records (and the send refuses a mock report).

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const apps = resolve(import.meta.dirname, '../../apps');
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;

it('AW-07b sender: nothing under apps/ imports the fake sender source', () => {
  const files = readdirSync(apps, { recursive: true, encoding: 'utf8' }).filter(
    (path) => SOURCE.test(path) && !/(?:^|\/)(?:node_modules|dist)\//u.test(path),
  );
  expect(files.length).toBeGreaterThan(0);
  const reaching = files.filter((path) =>
    /fakeSenderSource|email-sender-fake/u.test(readFileSync(join(apps, path), 'utf8')),
  );
  expect(reaching).toEqual([]);
});
