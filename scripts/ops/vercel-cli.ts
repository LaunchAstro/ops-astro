// SPDX-License-Identifier: AGPL-3.0-only
//
// How the web deploy (web-deploy.ts) asks the person's own `vercel` sign-in:
// the CLI's environment kept to PATH, HOME, TMPDIR and the two project ids,
// `vercel deploy --prebuilt --prod` answering the deployment's own address,
// and `vercel inspect --format json` read back for that address ready on
// production (only url, target and readyState are read).

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
