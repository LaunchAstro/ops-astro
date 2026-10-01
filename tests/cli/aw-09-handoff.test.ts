// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-09: the command line's honest hand-off for the review round's visual
// operation. `review.view` prints the app's own address for the task's page
// and sends nothing; a body or origin that cannot make an honest link is
// refused, never encoded into one that only looks right. The parity check
// fails a hand-off whose route the app does not draw, or whose name is a
// command's.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../apps/cli/main.ts';
// @ts-expect-error -- the parity runner is a plain JavaScript module
import { handoffFailures, run } from '../../scripts/command-parity.mjs';
import { VISUAL_HANDOFFS } from '../../packages/core-wire/src/index.ts';

const WEB = 'http://127.0.0.1:5190';

async function cli(args: readonly string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, env, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: async () => await Promise.resolve(''),
  });
  return { code, out, err, json: out.length === 1 ? JSON.parse(out[0] as string) : undefined };
}

const view = async (body: unknown, env: Record<string, string> = { OPS_ASTRO_WEB_URL: WEB }) =>
  await cli(['review.view', '--json', JSON.stringify(body)], env);

describe('AW-09 review.view hands off to the app', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prints the task page under the app origin, with no bearer, no business and no request', async () => {
    const fetch = vi.fn(() => {
      throw new Error('a hand-off sends nothing');
    });
    vi.stubGlobal('fetch', fetch);
    const answer = await view({ key: 'T-12' });
    expect(answer.code).toBe(0);
    expect(answer.json).toMatchObject({ handoff: `${WEB}/task/T-12`, operation: 'review.view' });
    expect(String(answer.json?.why)).toMatch(/task\.read/u);
    expect(fetch).not.toHaveBeenCalled();
    const flagged = await cli([
      'review.view',
      '--json',
      '{"key":"T-3"}',
      '--web',
      'https://ops.example',
    ]);
    expect(flagged.json?.handoff).toBe('https://ops.example/task/T-3');
  });

  it('refuses a key that is not one path segment, an undeclared field and a missing key', async () => {
    for (const key of [
      '',
      'T/12',
      '../settings',
      '%2Fadmin',
      'T 12',
      'T\t12',
      'Т-12',
      '?x=1',
      '#x',
      7,
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one process entry at a time
      const answer = await view({ key });
      expect(answer.code, String(key)).toBe(2);
      expect(answer.json).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['key'] });
    }
    expect((await view({ key: 'T-12', recordId: 'x' })).json).toMatchObject({
      names: ['recordId'],
    });
    expect((await view({})).json).toMatchObject({ names: ['key'] });
  });

  it('refuses an app origin that carries a path, query, credentials or another scheme', async () => {
    for (const web of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http://127.0.0.1:5190/evil',
      'http://127.0.0.1:5190/?next=x',
      'http://user:pass@127.0.0.1:5190',
      'not a url',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one process entry at a time
      const answer = await view({ key: 'T-12' }, { OPS_ASTRO_WEB_URL: web });
      expect(answer.code, web).toBe(2);
      expect(answer.json).toMatchObject({ names: ['web'] });
      expect(answer.out.join('')).not.toContain('pass');
    }
  });

  it('is listed in --help apart from the operations, and is no command', async () => {
    const help = await cli(['--help']);
    expect(help.out).toContain(`  review.view --json '{"key":"<key>"}'`);
    expect((await cli(['review.vieww'])).out.join('')).toContain('COMMAND_UNKNOWN');
  });

  it('parity fails a hand-off to a page the app does not draw, or named as a command', () => {
    expect(handoffFailures()).toStrictEqual([]);
    expect(run().failures).toStrictEqual([]);
    const [real] = VISUAL_HANDOFFS;
    expect(handoffFailures([{ ...real, route: '/review/:key' }])).toStrictEqual([
      'the hand-off review.view opens /review/:key, which the app does not draw',
    ]);
    expect(handoffFailures([{ ...real, name: 'task.read' }])).toStrictEqual([
      "the hand-off task.read is also a command's name",
    ]);
  });
});
