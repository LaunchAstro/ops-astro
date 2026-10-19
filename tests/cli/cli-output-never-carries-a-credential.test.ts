// SPDX-License-Identifier: AGPL-3.0-only
//
// Nothing the command line prints carries a credential it sent, on stdout or
// stderr, on a verb or an operation: a 200 that echoes the bearer and the
// delegation, a refusal whose code and fix carry them, a 500 body that does,
// a redirect to the other origin (which hears nothing) and a transport
// failure whose message carries them. Each exact value it sent is replaced by
// `(redacted)`; the server's own rule against echoing one stays the first guard.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTION, run, SANDBOX, standIn, type Route, type Seen } from './preset-stand-in.ts';
import { holds } from './verb-lines.ts';

const BEARER = 'sandbox-bearer-echo-canary';
const DELEGATION = 'sandbox-delegation-echo-canary';
const BOTH = `${BEARER} ${DELEGATION}`;

let folder: string;
let env: Record<string, string>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-output-redaction-'));
  writeFileSync(join(folder, 'token.sandbox'), `${BEARER}\n`, { mode: 0o600 });
  writeFileSync(join(folder, 'delegation.sandbox'), `${DELEGATION}\n`, { mode: 0o600 });
  env = {
    OPS_ASTRO_TOKEN_FILE: join(folder, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(folder, 'delegation'),
    OPS_ASTRO_BUSINESS: 'alpha',
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

const api = (url: URL): boolean => url.origin === SANDBOX && url.pathname.startsWith('/api/a/');

const ANSWERS: readonly {
  readonly name: string;
  readonly route: Route;
  readonly exit: number;
  readonly shown: boolean;
}[] = [
  {
    name: 'a 200 that echoes both',
    route: (url) => (api(url) ? Response.json({ ok: true, task: { title: BOTH } }) : undefined),
    exit: 0,
    shown: true,
  },
  {
    name: 'a refusal whose code and fix carry both',
    route: (url) =>
      api(url)
        ? Response.json(
            { refused: true, code: `NO_${BEARER}`, names: [], fixes: [`send ${BOTH}`] },
            { status: 403 },
          )
        : undefined,
    exit: 1,
    shown: true,
  },
  {
    name: 'a 500 body that carries both',
    route: (url) => (api(url) ? new Response(`fault ${BOTH}`, { status: 500 }) : undefined),
    exit: 4,
    shown: false,
  },
  {
    name: 'a redirect to the other origin',
    route: (url) =>
      api(url)
        ? new Response(BOTH, { status: 307, headers: { location: `${PRODUCTION}/api/${BEARER}` } })
        : undefined,
    exit: 4,
    shown: false,
  },
  {
    name: 'a transport failure whose message carries both',
    route: (url) => {
      if (!api(url)) return;
      throw new TypeError(`connect failed ${BOTH}`);
    },
    exit: 3,
    shown: false,
  },
];

const PATHS = [
  { name: 'a verb', argv: ['task', 'get', 'T-1', '--env', 'sandbox', '--agent'] },
  {
    name: 'an operation',
    argv: ['task.read', '--env', 'sandbox', '--agent', '--json', '{"recordId":"T-1"}'],
  },
] as const;

describe('the command line never prints a credential it sent', () => {
  PATHS.flatMap((path) => ANSWERS.map((answer) => ({ path, answer }))).forEach(
    ({ path, answer }) => {
      it(`${path.name}, ${answer.name}`, async () => {
        const stand = standIn(answer.route);
        vi.stubGlobal('fetch', stand.fetch);
        const answered = await run(path.argv, env);
        expect(answered.code).toBe(answer.exit);
        expect(holds(BEARER, answered.out, answered.err), 'the bearer was printed').toBe(false);
        expect(holds(DELEGATION, answered.out, answered.err), 'the delegation was printed').toBe(
          false,
        );
        if (answer.shown) expect(`${answered.out}${answered.err}`).toContain('(redacted)');
        const heard = stand.seen.filter((one: Seen) => new URL(one.url).origin === PRODUCTION);
        expect(heard).toStrictEqual([]);
      });
    },
  );

  it('a bearer set by hand is redacted from an echo too', async () => {
    const hand = 'hand-set-bearer-echo-canary';
    const stand = standIn((url) =>
      url.origin === SANDBOX ? Response.json({ ok: true, task: { title: hand } }) : undefined,
    );
    vi.stubGlobal('fetch', stand.fetch);
    for (const argv of [
      ['task', 'get', 'T-1'],
      ['task.read', '--json', '{"recordId":"T-1"}'],
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one path, then the other
      const answered = await run(argv, {
        ...env,
        OPS_ASTRO_TOKEN: hand,
        OPS_ASTRO_API_URL: SANDBOX,
      });
      expect(answered.code).toBe(0);
      expect(holds(hand, answered.out, answered.err), 'the bearer was printed').toBe(false);
    }
  });
});
