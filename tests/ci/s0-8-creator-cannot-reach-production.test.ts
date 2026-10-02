// SPDX-License-Identifier: AGPL-3.0-only
//
// Preview deployments, the create half (ticket S0-8, owner's yes on O-10,
// 1 Oct 2026: a deploy hook in the existing team, no token, no spend).
// `S0-8 creator cannot reach production`, the part proved without staging:
// the creator puts one full commit on the preview branch under the person's
// own git sign-in and posts once to the previews project's deploy hook. It
// carries no Vercel token and reaches no other Vercel address, so it cannot
// deploy, promote, alias, publish, or change a domain, an environment
// variable or a project setting. The half that needs Vercel itself (the
// hook made for the preview branch, the Viewer's project-scoped token
// refused everywhere else) waits for staging's sitting.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitPush, PREVIEW_BRANCH, pushArgs, requestPreview } from '../../scripts/ops/preview.ts';

const PREVIEWS = 'prj_previews01';
const STAGING = 'prj_staging01';
const SECRET = 'canary7c2f41hooksecret';
const HOOK = `https://api.vercel.com/v1/integrations/deploy/${PREVIEWS}/${SECRET}`;
const VERSION = '0123456789abcdef0123456789abcdef01234567';
const JOB = { job: { id: 'job0123456789', state: 'PENDING', createdAt: 1 } };

type Env = Record<string, string | undefined>;
const settings = (over: Env = {}): Env => ({
  PREVIEW_DEPLOY_HOOK: HOOK,
  PREVIEWS_VERCEL_PROJECT_ID: PREVIEWS,
  VERCEL_PROJECT_ID: STAGING,
  ...over,
});

/** A creator whose push and post are recorded, never sent anywhere. */
function creator(env: Env, answer: () => Response = () => Response.json(JOB), pushed = true) {
  const pushes: [string, string][] = [];
  const posts: [string, RequestInit][] = [];
  const run = (version: string) =>
    requestPreview(
      { version },
      {
        env,
        push: (v, branch) => (pushes.push([v, branch]), pushed),
        post: (url, init) => (posts.push([url, init]), Promise.resolve(answer())),
      },
    );
  return { run, pushes, posts };
}

describe('S0-8 creator cannot reach production', () => {
  refusedAddresses();
  refusedSettings();
  requestedCases();
  pushEnvironmentCase();
});

function refusedAddresses() {
  it.each([
    ['a deploy', 'https://api.vercel.com/v13/deployments'],
    ['a promote', `https://api.vercel.com/v10/projects/${PREVIEWS}/promote/dpl_x`],
    ['an alias', 'https://api.vercel.com/v2/deployments/dpl_x/aliases'],
    ['an environment variable change', `https://api.vercel.com/v10/projects/${PREVIEWS}/env`],
    ['a domain change', `https://api.vercel.com/v10/projects/${PREVIEWS}/domains`],
    ['a project setting change', `https://api.vercel.com/v9/projects/${PREVIEWS}`],
    [
      'a hook over plain http',
      `http://api.vercel.com/v1/integrations/deploy/${PREVIEWS}/${SECRET}`,
    ],
    [
      'a look-alike host',
      `https://api.vercel.com.example/v1/integrations/deploy/${PREVIEWS}/${SECRET}`,
    ],
    ['a hook with options', `${HOOK}?buildCache=false`],
  ])('refuses %s address and sends nothing', async (_, address) => {
    const c = creator(settings({ PREVIEW_DEPLOY_HOOK: address }));
    const outcome = await c.run(VERSION);
    expect(outcome.kind).toBe('refused');
    expect(c.pushes).toEqual([]);
    expect(c.posts).toEqual([]);
  });
}

function refusedSettings() {
  it.each([
    [
      'the staging or production project',
      `https://api.vercel.com/v1/integrations/deploy/${STAGING}/${SECRET}`,
    ],
    [
      'a project other than the previews one',
      `https://api.vercel.com/v1/integrations/deploy/prj_other01/${SECRET}`,
    ],
  ])('refuses a hook on %s', async (_, address) => {
    const c = creator(settings({ PREVIEW_DEPLOY_HOOK: address }));
    expect((await c.run(VERSION)).kind).toBe('refused');
    expect([c.pushes, c.posts]).toEqual([[], []]);
  });

  it('refuses when the previews project is the staging or production project', async () => {
    const c = creator(
      settings({ PREVIEWS_VERCEL_PROJECT_ID: PREVIEWS, VERCEL_PROJECT_ID: PREVIEWS }),
    );
    expect((await c.run(VERSION)).kind).toBe('refused');
    expect([c.pushes, c.posts]).toEqual([[], []]);
  });

  it('refuses while a Vercel token is in its environment', async () => {
    const c = creator(settings({ VERCEL_TOKEN: 'canary-token' }));
    expect((await c.run(VERSION)).kind).toBe('refused');
    expect([c.pushes, c.posts]).toEqual([[], []]);
  });

  it.each(['main', '--prod', 'HEAD', '0123456', `${VERSION}:refs/heads/main`, `+${VERSION}`])(
    'refuses %s as the version: only one full commit is previewed',
    async (version) => {
      const c = creator(settings());
      expect((await c.run(version)).kind).toBe('refused');
      expect([c.pushes, c.posts]).toEqual([[], []]);
    },
  );
}

function requestedCases() {
  it('pushes the commit to the preview branch only, then posts once to the hook with no credential and no body', async () => {
    const c = creator(settings());
    const outcome = await c.run(VERSION);
    expect(outcome).toStrictEqual({
      kind: 'requested',
      record: {
        action: 'preview requested',
        version: VERSION,
        branch: 'preview-request',
        project: PREVIEWS,
        job: 'job0123456789',
      },
    });
    expect(c.pushes).toEqual([[VERSION, PREVIEW_BRANCH]]);
    expect(c.posts).toHaveLength(1);
    const [url, init] = c.posts[0]!;
    expect(url).toBe(HOOK);
    expect(init).toStrictEqual({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(pushArgs(VERSION)).toEqual([
      'push',
      '--no-follow-tags',
      '--no-recurse-submodules',
      'origin',
      `+${VERSION}:refs/heads/preview-request`,
    ]);
  });

  it('posts nothing when the push fails, and records nothing when the hook answers no job', async () => {
    const failedPush = creator(settings(), undefined, false);
    expect((await failedPush.run(VERSION)).kind).toBe('failed');
    expect(failedPush.posts).toEqual([]);
    const answers = [() => new Response('no', { status: 500 }), () => Response.json({ job: {} })];
    const outcomes = await Promise.all(answers.map((a) => creator(settings(), a).run(VERSION)));
    expect(outcomes.map((o) => o.kind)).toEqual(['failed', 'failed']);
  });

  it("never names the hook's secret in a record or a refusal", async () => {
    const outcomes = [
      await creator(settings()).run(VERSION),
      await creator(settings({ PREVIEW_DEPLOY_HOOK: `${HOOK}?x=1` })).run(VERSION),
      await creator(settings(), () => new Response(SECRET, { status: 500 })).run(VERSION),
    ];
    expect(JSON.stringify(outcomes)).not.toContain(SECRET);
  });
}

function pushEnvironmentCase() {
  it('hands git no hook, database or bearer value', () => {
    const bin = mkdtempSync(join(tmpdir(), 's0-8-git-'));
    try {
      const seen = join(bin, 'seen');
      writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" > '${seen}'\nenv >> '${seen}'\n`);
      chmodSync(join(bin, 'git'), 0o700);
      const env = {
        ...settings(),
        PATH: `${bin}:/usr/bin:/bin`,
        DATABASE_ADMIN_URL: 'postgres://canary-admin',
        OPS_ASTRO_TOKEN: 'canary-bearer',
      };
      expect(gitPush(VERSION, env)).toBe(true);
      const log = readFileSync(seen, 'utf8');
      expect(log.split('\n')[0]).toBe(pushArgs(VERSION).join(' '));
      expect(log).not.toMatch(/canary|PREVIEW_DEPLOY_HOOK|DATABASE_|OPS_ASTRO_/u);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
}
