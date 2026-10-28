// SPDX-License-Identifier: AGPL-3.0-only
//
// How the web deploy (web-deploy.ts) asks the person's own `vercel` sign-in:
// the CLI's environment kept to PATH, HOME, TMPDIR and the two project ids,
// `vercel deploy --prebuilt --prod` answering the deployment's own address,
// and `vercel inspect --format json` read back for that address ready on
// production (only url, target and readyState are read). Production's
// rollback (`vercel rollback`) and the promote after it (`vercel promote`) go
// only to a deployment read back that way (#2299).

import { spawnSync } from 'node:child_process';

type Environment = Readonly<Record<string, string | undefined>>;

/** A deployment's own address as `vercel deploy` prints it. */
const DEPLOYMENT = /^https:\/\/[a-z0-9-]{1,100}\.vercel\.app$/u;

/** The environment the CLI runs with: where it is, whose sign-in, which project. */
function cliEnvironment(env: Environment): Record<string, string> {
  const kept = ['PATH', 'HOME', 'TMPDIR', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'];
  return {
    ...Object.fromEntries(kept.flatMap((name) => (env[name] ? [[name, env[name]]] : []))),
    VERCEL_TELEMETRY_DISABLED: '1',
  };
}

function vercel(
  args: readonly string[],
  env: Environment,
  cwd: string,
): { ok: boolean; out: string } {
  const result = spawnSync('vercel', args, {
    cwd,
    env: cliEnvironment(env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

/** Whether `vercel inspect --format json` reports `deployment` ready on production. */
function readyOnProduction(answer: string, deployment: string): boolean {
  try {
    const reported = JSON.parse(answer) as {
      url?: unknown;
      target?: unknown;
      readyState?: unknown;
    };
    return (
      `https://${String(reported.url)}` === deployment &&
      reported.target === 'production' &&
      reported.readyState === 'READY'
    );
  } catch {
    return false;
  }
}

/** `vercel deploy --prebuilt --prod` of `folder`'s output: the deployment's own address, if any. */
export function deployPrebuilt(folder: string, env: Environment): string | undefined {
  const made = vercel(['deploy', '--prebuilt', '--prod'], env, folder);
  const deployment = made.out.split('\n').at(-1) ?? '';
  return made.ok && DEPLOYMENT.test(deployment) ? deployment : undefined;
}

/** Why Vercel's read-back does not confirm `deployment` ready on production, or undefined when it does. */
export function readBack(
  folder: string,
  env: Environment,
  deployment: string,
): { kind: 'failed'; reason: string } | undefined {
  const inspected = vercel(['inspect', deployment, '--format', 'json'], env, folder);
  if (inspected.ok && readyOnProduction(inspected.out, deployment)) return undefined;
  return {
    kind: 'failed',
    reason: `Vercel did not report ${deployment} ready on production, so its syd1 output is not confirmed live. It is not recorded. Remove it from the dashboard and find out why.`,
  };
}

type Unrecorded = { kind: 'refused' | 'failed'; reason: string };

/**
 * Vercel's instant rollback of production to `deployment` (#2299): the build
 * Vercel already holds, with the settings it was made with, so settings
 * changed since never reach it. Refused unless Vercel reports it ready on
 * production first, since Vercel answers a rollback or promote to any other
 * deployment by building a new one with today's settings. `vercel rollback`
 * waits up to 3 minutes for its alias job and exits 0 only once it succeeded.
 */
export function rollBack(
  folder: string,
  env: Environment,
  deployment: string,
): Unrecorded | undefined {
  const inspected = vercel(['inspect', deployment, '--format', 'json'], env, folder);
  if (!inspected.ok || !readyOnProduction(inspected.out, deployment)) {
    return {
      kind: 'refused',
      reason: `Vercel's read-back says ${deployment} is not ready on production, so it is not rolled back to: Vercel would build any other deployment again with today's settings. Nothing changed.`,
    };
  }
  if (vercel(['rollback', deployment, '--timeout', '3m'], env, folder).ok) return undefined;
  return {
    kind: 'failed',
    reason: `vercel rollback to ${deployment} did not finish, so production may still serve what it served. Nothing was recorded; read \`vercel rollback status\`.`,
  };
}

/**
 * `deployment`, already read back ready on production, given production's
 * domain: after a rollback Vercel gives new deployments none until one is
 * promoted (#2299).
 */
export function promote(
  folder: string,
  env: Environment,
  deployment: string,
): Unrecorded | undefined {
  if (vercel(['promote', deployment, '--timeout', '3m'], env, folder).ok) return undefined;
  return {
    kind: 'failed',
    reason: `${deployment} is ready on production, but the domain may still serve the rolled-back deployment: vercel promote did not finish. It is not recorded; run vercel promote ${deployment}, then deploy again.`,
  };
}
