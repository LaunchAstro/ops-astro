// SPDX-License-Identifier: AGPL-3.0-only
//
// `connectionOf` names the default credential files, `.local/cli-token` and
// `.local/cli-delegation`, with the preset's name added under a preset and
// plain without one, and reads no file to do it: every `node:fs` call made
// while it runs is recorded and refused. What it names is what gets sent
// (`verb-preset-matrix-sends-each-preset-its-own-credentials`).

import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { connectionOf } from '../../apps/cli/main.ts';

const trip = vi.hoisted(() => ({ armed: false, touched: [] as string[] }));

vi.mock('node:fs', async (original) => {
  const real = await original<Record<string, unknown>>();
  const wired = Object.fromEntries(
    Object.entries(real).map(([name, value]) => [
      name,
      typeof value === 'function'
        ? (...args: unknown[]): unknown => {
            if (!trip.armed) return (value as (...a: unknown[]) => unknown)(...args);
            trip.touched.push(name);
            throw new Error(`node:fs ${name} called`);
          }
        : value,
    ]),
  );
  return { ...wired, default: wired };
});

const ROOT = join(import.meta.dirname, '..', '..');

it.each([
  { preset: 'sandbox', tail: '.sandbox' },
  { preset: 'production', tail: '.production' },
  { preset: undefined, tail: '' },
])('the default files under $preset end in "$tail", with no file read', ({ preset, tail }) => {
  trip.armed = true;
  let connection;
  try {
    connection = connectionOf(preset === undefined ? {} : { env: preset }, {});
  } finally {
    trip.armed = false;
  }
  expect(trip.touched).toStrictEqual([]);
  expect(connection.tokenFile).toBe(join(ROOT, '.local', `cli-token${tail}`));
  expect(connection.delegationFile).toBe(join(ROOT, '.local', `cli-delegation${tail}`));
});
