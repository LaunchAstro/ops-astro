// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, require-await, unicorn/prefer-string-replace-all, require-unicode-regexp -- the review's S2007-4 proof, kept as written */
//
// From the cross-vendor review of #2007 (S2007-4), copied unchanged but for
// this header, the test name, and its describe and expect doubles moved to
// module scope for the lint rule.
//
// Independent no-database proof. Executes the committed test callback with
// controlled asynchronous database doubles, rather than testing copied code.
// SOL_SOURCE_REVISION selects the old committed test without changing checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const describe = (_name, body) => body();
describe.skipIf = () => describe;
const expect = (actual) => ({
  toMatchObject(expected) {
    for (const key of Object.keys(expected)) {
      assert.deepEqual(actual?.[key], expected[key], `premature observation: ${key}`);
    }
  },
  toBe(expected) {
    assert.deepEqual(actual, expected);
  },
  toEqual(expected) {
    assert.deepEqual({ ...actual }, { ...expected });
  },
});

test('the single-statement proof waits for its lock before observing it', async () => {
  const path = 'tests/tenancy/migration-runner-queued-reader-and-lock-scope.test.ts';
  const revision = process.env.SOL_SOURCE_REVISION;
  const source = revision
    ? execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' })
    : readFileSync(path, 'utf8');
  const cases = new Map();
  const register = (name, body) => cases.set(name, body);
  register.skipIf = () => register;
  class MigrationRefused extends Error {}
  let polls = 0;
  let waiting = false;
  let finishRead;
  let observation;
  const reading = new Promise((resolve) => {
    finishRead = resolve;
  });
  const watch = {
    async execute(text) {
      if (text.includes("wait_event='PgSleep'")) return [{ sleeping: true }];
      if (text.includes('as same_start')) {
        observation = { waiting, same_start: true, other_locks: 0 };
        return [observation];
      }
      if (text.includes('as waiting')) {
        // The reader takes one polling interval to reach the table lock.
        // Both versions see exactly the same schedule and SQL responses.
        polls += 1;
        if (polls === 2) {
          waiting = true;
          finishRead([{ value: 'old' }]);
        }
        return [{ waiting }];
      }
      throw new Error(`unexpected watcher SQL: ${text}`);
    },
    async close() {},
  };
  const sql = {
    unsafe(text) {
      if (text === 'select pg_backend_pid() as pid') return Promise.resolve([{ pid: 123 }]);
      if (text === 'select public.sol_read() as value') return reading;
      throw new Error(`unexpected reader SQL: ${text}`);
    },
    async end() {},
  };
  const db = {
    name: 'sol_synchronisation',
    admin: {
      async execute(text) {
        if (text.includes('count(*)')) return [{ n: 0 }];
        return [];
      },
    },
    async drop() {},
  };
  const context = vm.createContext({
    it: register,
    describe,
    expect,
    pause,
    setTimeout,
    URL,
    databaseUrlFromEnvironment: () => 'postgres://localhost/unused',
    createEmptyDatabase: async () => db,
    connectAsAdmin: () => watch,
    postgres: () => sql,
    applyMigrations: async () => {
      throw new MigrationRefused();
    },
    MigrationRefused,
  });
  // Remove only imports; Node strips type annotations from the actual source.
  const executable = stripTypeScriptTypes(source.replace(/^import\b[\s\S]*?;\n/gm, ''));
  vm.runInContext(executable, context, { filename: path });
  const body = cases.get('refuses a single queued statement that already read the old function');
  assert.equal(typeof body, 'function');
  try {
    await body();
  } finally {
    // Let the controlled pending polling loop settle even on assertion failure.
    await pause(50);
    console.log(JSON.stringify({ revision: revision ?? 'working head', polls, observation }));
  }
});
