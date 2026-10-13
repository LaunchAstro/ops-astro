// SPDX-License-Identifier: AGPL-3.0-only
//
// A database address the driver cannot parse is refused with an error that
// carries neither the address nor its password, from every way the product
// opens a connection. The server and the hosted function hand these errors to
// their logs, so the error itself is what must stay clean.

import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  connect,
  connectAsAdmin,
  connectListener,
  connectObserved,
} from '../../packages/core-records/src/tenancy/database.ts';

const password = 'malformed-address-password-canary-7731';
const malformed = [
  `postgres://owner:${password}@127.0.0.1:bad/database`,
  `postgres://owner:${password}@[::1/database`,
  `postgres://owner:${password}@127.0.0.1:99999/database`,
  `postgres://owner:${password}@data base/database`,
  `postgres://owner:${password}@host%zz/database`,
];
const factories = { connect, connectAsAdmin, connectListener, connectObserved };

/** What a log would print of the error, its cause and every own property included. */
function printed(error: unknown): string {
  return `${inspect(error, { depth: 10, showHidden: true })} ${String(error)}`;
}

describe('a malformed database address', () => {
  for (const [name, open] of Object.entries(factories)) {
    it.each(malformed)(`${name} refuses %j without its password in the error`, (url) => {
      let thrown: unknown;
      try {
        open(url);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(printed(thrown)).not.toContain(password);
      expect(printed(thrown)).not.toContain('owner:');
      expect((thrown as Error).message).toMatch(/database address/u);
    });
  }
});
