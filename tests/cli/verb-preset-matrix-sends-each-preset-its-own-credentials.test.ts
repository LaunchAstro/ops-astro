// SPDX-License-Identifier: AGPL-3.0-only
//
// Every verb, under each preset and each way of naming it, sends that
// preset's own bearer, and in agent mode its own delegation, to that preset's
// origin only. Custom credential files hold six distinct canaries; the four
// that do not belong to the call appear in no URL, header or body.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/index.ts';
import { PRODUCTION, run, SANDBOX, standIn, type Seen } from './preset-stand-in.ts';
import { holds, SMALLEST_LINE } from './verb-lines.ts';

const ORIGIN: Readonly<Record<string, string>> = { sandbox: SANDBOX, production: PRODUCTION };
const OTHER: Readonly<Record<string, string>> = { sandbox: 'production', production: 'sandbox' };

/** The bearer and delegation canary each file holds, by its suffix ('' for the plain file). */
const BEARER: Readonly<Record<string, string>> = {
  '': 'plain-bearer-canary',
  sandbox: 'sandbox-bearer-canary',
  production: 'production-bearer-canary',
};
const DELEGATION: Readonly<Record<string, string>> = {
  '': 'plain-delegation-canary',
  sandbox: 'sandbox-delegation-canary',
  production: 'production-delegation-canary',
};

let folder: string;
let seen: Seen[];
let env: Record<string, string>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-verb-matrix-'));
  const stand = standIn();
  seen = stand.seen;
  vi.stubGlobal('fetch', stand.fetch);
  const bearer = join(folder, 'my-bearer');
  const delegation = join(folder, 'my-pickup');
  for (const suffix of ['', 'sandbox', 'production']) {
    const tail = suffix === '' ? '' : `.${suffix}`;
    writeFileSync(`${bearer}${tail}`, `${BEARER[suffix] ?? ''}\n`, { mode: 0o600 });
    writeFileSync(`${delegation}${tail}`, `${DELEGATION[suffix] ?? ''}\n`, { mode: 0o600 });
  }
  env = {
    OPS_ASTRO_TOKEN_FILE: bearer,
    OPS_ASTRO_DELEGATION_FILE: delegation,
    OPS_ASTRO_BUSINESS: 'alpha',
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

const selectors = (preset: string) =>
  [
    { name: `--env ${preset}`, argv: ['--env', preset], env: {} },
    { name: `--env=${preset}`, argv: [`--env=${preset}`], env: {} },
    { name: `OPS_ASTRO_ENV=${preset}`, argv: [], env: { OPS_ASTRO_ENV: preset } },
    {
      name: `--env ${preset} over OPS_ASTRO_ENV=${OTHER[preset] ?? ''}`,
      argv: ['--env', preset],
      env: { OPS_ASTRO_ENV: OTHER[preset] ?? '' },
    },
  ] as const;

const MODES = [
  { name: 'person', agent: false, argv: [], env: {} },
  { name: '--agent', agent: true, argv: ['--agent'], env: {} },
  { name: 'OPS_ASTRO_AGENT=1', agent: true, argv: [], env: { OPS_ASTRO_AGENT: '1' } },
] as const;

describe.each(Object.entries(SMALLEST_LINE))('%s', (_verb, line) => {
  it('sends each preset its own bearer and delegation, and nothing of the others', async () => {
    for (const preset of ['sandbox', 'production']) {
      for (const selector of selectors(preset)) {
        for (const mode of MODES) {
          const label = `${selector.name}, ${mode.name}`;
          seen.length = 0;
          // eslint-disable-next-line no-await-in-loop -- one run at a time, each checked alone
          const answered = await run([...line, ...selector.argv, ...mode.argv], {
            ...env,
            ...selector.env,
            ...mode.env,
          });
          expect(answered.code, label).toBe(0);
          expect(seen.length, label).toBe(1);
          const [sent] = seen as [Seen];
          expect(new URL(sent.url).origin, label).toBe(ORIGIN[preset]);
          expect(sent.headers['authorization'], label).toBe(`Bearer ${BEARER[preset] ?? ''}`);
          expect(sent.headers[DELEGATION_HEADER], label).toBe(
            mode.agent ? DELEGATION[preset] : undefined,
          );
          const wire = JSON.stringify(seen);
          const printed = `${answered.out}\n${answered.err}`;
          const foreign = [
            ...Object.entries(BEARER).filter(([suffix]) => suffix !== preset),
            ...Object.entries(DELEGATION).filter(([suffix]) => suffix !== preset || !mode.agent),
          ].map(([, canary]) => canary);
          for (const canary of foreign) {
            expect(holds(canary, wire, printed), `${label}: a foreign canary was sent`).toBe(false);
          }
        }
      }
    }
  });
});
