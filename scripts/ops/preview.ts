// SPDX-License-Identifier: AGPL-3.0-only
//
// Preview deployments, the create half (ticket S0-8; the owner's yes on O-10,
// 1 Oct 2026: previews in the existing Vercel team, made by a deploy hook,
// read by a free Viewer's project-scoped token, no spend).
//
// A person's act under `operations:manage` (`preview.mjs` asks the operator
// gate first). The creator holds no Vercel identity at all. It puts one full
// commit on the preview branch under the person's own git sign-in, then posts
// once, with no body and no credential, to the previews project's deploy
// hook, a secret address that can only build the branch it was made for. It
// refuses any other Vercel address, a hook naming any project but the one in
// PREVIEWS_VERCEL_PROJECT_ID, and a run with a Vercel token in its
// environment, so it can never deploy, promote, alias or publish, nor change
// a domain, an environment variable or a project setting (`S0-8 creator
// cannot reach production`). That the previews project is not staging's or
// production's is checked only against VERCEL_PROJECT_ID when it is set: the
// guard against a hook on the wrong project is Vercel's, proved at staging's
// sitting. The hook's address is a bearer secret: no record or refusal, and
// not git's environment, holds it.
//
// Not here yet, waiting for staging: the hook made for the preview branch on
// Vercel's side, and the Viewer token's read-back of the built preview (its
// commit, its target), refused on every other project. Requests take turns on
// the branch through the preview lock (`requestPreview`), so commands run at
// once on one machine and sign-in each build the commit they record; commands
// from two machines or accounts are told apart only by that read-back.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

type Environment = Readonly<Record<string, string | undefined>>;

/** The one branch the previews project's hook builds; never the production branch. */
export const PREVIEW_BRANCH = 'preview-request';
const VERSION = /^[0-9a-f]{40}$/u;
const PROJECT = /^prj_[A-Za-z0-9]{1,64}$/u;
const HOOK =
  /^https:\/\/api\.vercel\.com\/v1\/integrations\/deploy\/(prj_[A-Za-z0-9]{1,64})\/[A-Za-z0-9]{1,128}$/u;
const JOB = /^[A-Za-z0-9]{1,64}$/u;

export interface PreviewRecord {
  readonly action: 'preview requested';
  readonly version: string;
  readonly branch: typeof PREVIEW_BRANCH;
  readonly project: string;
  readonly job: string;
}
export type PreviewOutcome =
  { kind: 'refused' | 'failed'; reason: string } | { kind: 'requested'; record: PreviewRecord };

export interface PreviewDeps {
  readonly env: Environment;
  /** Puts `version` on `branch` at origin; true when the push took. */
  readonly push: (version: string, branch: string) => boolean;
  readonly post: (url: string, init: RequestInit) => Promise<Response>;
}

/** `git push` of one commit to the preview branch alone, as the person signed in to git. */
export const pushArgs = (version: string): string[] => [
  'push',
  '--no-follow-tags',
  '--no-recurse-submodules',
  'origin',
  `+${version}:refs/heads/${PREVIEW_BRANCH}`,
];

/** What git needs to find itself and the person's sign-in; no hook, database or bearer value. */
const GIT_KEPT = ['PATH', 'HOME', 'TMPDIR', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND'];

/** The push the command uses: the person's git, its environment held to `GIT_KEPT`. */
export function gitPush(version: string, env: Environment): boolean {
  const kept = Object.fromEntries(
    GIT_KEPT.flatMap((name) => (env[name] ? [[name, env[name]]] : [])),
  );
  const result = spawnSync('git', pushArgs(version), { env: kept, stdio: 'inherit' });
  return result.status === 0;
}

/** Why the settings cannot create a preview, naming each setting, never its value. */
function settingProblems(env: Environment): string[] {
  const previews = env['PREVIEWS_VERCEL_PROJECT_ID'] ?? '';
  const hook = HOOK.exec(env['PREVIEW_DEPLOY_HOOK'] ?? '');
  const problems: string[] = [];
  if (!PROJECT.test(previews))
    problems.push('PREVIEWS_VERCEL_PROJECT_ID is not a Vercel project id');
  else if (previews === env['VERCEL_PROJECT_ID'])
    problems.push('PREVIEWS_VERCEL_PROJECT_ID names the staging or production project');
  if (hook === null) problems.push('PREVIEW_DEPLOY_HOOK is not a Vercel deploy hook address');
  else if (hook[1] !== previews)
    problems.push('PREVIEW_DEPLOY_HOOK is not the previews project hook');
  if ((env['VERCEL_TOKEN'] ?? '') !== '')
    problems.push('VERCEL_TOKEN is set: a preview is created by the deploy hook only');
  return problems;
}

/** The hook's job id from its answer, or undefined. */
async function jobOf(asked: Promise<Response>): Promise<string | undefined> {
  try {
    const answer = await asked;
    const { job } = (await answer.json()) as { job?: { id?: unknown } };
    return answer.ok && typeof job?.id === 'string' && JOB.test(job.id) ? job.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The preview lock: the branch holds one commit at a time, so a request, in
 * this process or another, pushes only once the one before has its hook's
 * answer, and each job is asked while the branch holds the commit its record
 * names. A directory, made and removed whole, as auth-up.sh locks its key;
 * waited on for a minute at most. It sits in the sign-in's home folder as the
 * system records it, never where TMPDIR or HOME point, so every command the
 * sign-in runs on this machine, from any checkout, takes the same one.
 */
export const PREVIEW_LOCK: string = join(userInfo().homedir, '.ops-astro-preview-request.lock');
const LOCK_WAIT_MS = 60_000;

async function lockPreview(until: number): Promise<boolean> {
  try {
    mkdirSync(PREVIEW_LOCK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() > until) return false;
  }
  await sleep(100);
  return lockPreview(until);
}

export async function requestPreview(
  request: { version: string },
  deps: PreviewDeps,
): Promise<PreviewOutcome> {
  const problems = settingProblems(deps.env);
  if (!VERSION.test(request.version)) problems.push('the version is not one full commit id');
  if (problems.length > 0)
    return { kind: 'refused', reason: `${problems.join('; ')}. Nothing was pushed or built.` };
  if (!(await lockPreview(Date.now() + LOCK_WAIT_MS)))
    return {
      kind: 'refused',
      reason: `another preview request holds ${PREVIEW_LOCK}; if none is running, remove it. Nothing was pushed or built.`,
    };
  try {
    return await pushThenAsk(request, deps);
  } finally {
    rmSync(PREVIEW_LOCK, { recursive: true, force: true });
  }
}

async function pushThenAsk(
  request: { version: string },
  deps: PreviewDeps,
): Promise<PreviewOutcome> {
  if (!deps.push(request.version, PREVIEW_BRANCH))
    return {
      kind: 'failed',
      reason: `the push to ${PREVIEW_BRANCH} failed; no preview was asked for`,
    };
  const hook = deps.env['PREVIEW_DEPLOY_HOOK'] ?? '';
  const job = await jobOf(
    deps.post(hook, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000) }),
  );
  if (job === undefined)
    return { kind: 'failed', reason: 'the deploy hook did not answer a job; nothing was recorded' };
  const project = deps.env['PREVIEWS_VERCEL_PROJECT_ID'] ?? '';
  const record = { action: 'preview requested', version: request.version, project, job } as const;
  return { kind: 'requested', record: { ...record, branch: PREVIEW_BRANCH } };
}
