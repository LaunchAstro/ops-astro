// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const suite = readFileSync(new URL('../runtime/t3e2-outage.test.ts', import.meta.url), 'utf8');

test('outage isolation tests two clients with one grant each and two granted people', () => {
  const clients = [...suite.matchAll(/const (\w+) = await cq8World\(s\)\.client\(/gu)].map(
    (match) => match[1],
  );
  assert.ok(clients.length >= 2, 'the outage suite must create two same-business clients');
  for (const name of clients) {
    assert.match(suite, new RegExp(`queueOf\\(s, ${name}\\)`), `the suite must read as ${name}`);
  }

  const scopedMembers = [
    ...suite.matchAll(/grantTo\(tx,\s*(\w+),\s*'read',\s*\{\s*kind:\s*'record'/gu),
  ].map((match) => match[1]);
  assert.ok(
    scopedMembers.length >= 2,
    'the outage suite must give two people separate record grants',
  );
  for (const name of scopedMembers) {
    assert.match(suite, new RegExp(`queueOf\\(s, ${name}\\)`), `the suite must read as ${name}`);
  }
});
