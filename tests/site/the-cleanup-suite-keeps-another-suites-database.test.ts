// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof on #2094 (S2094-4), body unchanged: while the phrase cleanup
// suite runs, another suite's database of the same name shape is kept.
/* eslint-disable max-lines-per-function, no-unmodified-loop-condition, no-await-in-loop, no-promise-executor-return -- Sol's proof body, kept as written */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const url = databaseUrlFromEnvironment();
if (url === undefined) console.warn('Cleanup ownership: DATABASE_URL is unset, so nothing ran.');

it.skipIf(url === undefined)(
  'the cleanup suite does not drop another concurrent suite database',
  async () => {
    if (url === undefined) throw new Error('Database required');
    const admin = connectAsAdmin(url);
    const names = async () =>
      (
        await admin.execute<{ datname: string }>(
          "select datname from pg_database where datname like 't1_phrase_%'",
        )
      ).map((row) => row.datname);
    const baseline = new Set(await names());
    const mine = `t1_phrase_${randomBytes(6).toString('hex')}`;
    const child = spawn(
      './node_modules/.bin/vitest',
      ['run', 'tests/site/the-phrase-request-suite-removes-its-throwaway-database.test.ts'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    let done = false;
    const ended = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        done = true;
        resolve(code);
      });
    });
    try {
      // Its child database appears only after the cleanup suite's baseline snapshot.
      const deadline = Date.now() + 20000;
      let observed = false;
      while (!done && Date.now() < deadline) {
        if ((await names()).some((name) => !baseline.has(name))) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observed, output).toBe(true);
      await admin.execute(`create database "${mine}"`);
      await admin.execute(`create role "${mine}_app"`);
      await admin.execute(`create role "${mine}_out"`);
      const exit = await ended;
      expect(
        { exit, preserved: (await names()).includes(mine) },
        'The cleanup suite must preserve the database made by this other concurrent suite',
      ).toEqual({ exit: 0, preserved: true });
    } finally {
      if (!done) {
        child.kill('SIGTERM');
        await ended;
      }
      await admin.execute(`drop database if exists "${mine}" with (force)`);
      await admin.execute(`drop role if exists "${mine}_app"`);
      await admin.execute(`drop role if exists "${mine}_out"`);
      await admin.close();
    }
  },
  40000,
);
