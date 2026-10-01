// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging web deploy on Vercel (ticket S0-6, `deploy recorded`; the Vercel
// re-plan, section 11 step 4). It sits beside `deploy.ts`, which still starts
// the machine's own containers.
//
// A person's act under `operations:manage`: `web-deploy.mjs` asks the operator
// gate first. This takes the build output the store holds for the version
// asked (`storedArtefact`: a clean build, its stamp, its digest), copies it into
// a folder of its own as `.vercel/output`, and checks the copy again (the same
// digest, `buildOutputProblems`), so the bytes Vercel is handed are the ones
// checked. Staging's database must pass the made-up-only preflight first.
//
// Vercel is asked twice, through the person's own `vercel` sign-in, never a
// token: `vercel deploy --prebuilt --prod` (its answer on stdout is the new
// deployment's own address) and `vercel inspect <address> --format json`, whose
// `regions` must be `syd1` alone (`S0-6 functions in Sydney`). The CLI gets only
// PATH, HOME, TMPDIR and the two project ids, so no sign-in value or database
// login reaches it. The folder, `.vercel` and all, is removed whatever happens.
// Before Vercel is asked, the sign-in server reports its version (`/health`
// under GOTRUE_URL, staging's own sign-in address, with the publishable key
// when set); no answer, no deploy. Only a deploy read back in Sydney returns
// its record: the version, the artefact, the digest, the deployment, the
// region, the function runtime and the sign-in server's version (`S0-6 image
// pins`).
//
// The maintenance page (`deployMaintenance`, `maintenance.ts`) goes out the
// same prebuilt way, with no database asked, so a broken database never keeps
// it off; it holds no function, so there is no region to read back. Deploying
// a version again takes it off.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOutputProblems, outputDigest } from './build-output.ts';
import { writeMaintenanceOutput } from './maintenance.ts';
import { storedArtefact } from './promotion.ts';

type Environment = Readonly<Record<string, string | undefined>>;

export interface WebDeployRecord {
  readonly action: 'deploy recorded';
  readonly version: string;
  readonly artefact: string;
  readonly digest: string;
  readonly deployment: string;
  readonly region: 'syd1';
  readonly runtime: string;
  readonly authVersion: string;
}

type Unrecorded = { kind: 'refused' | 'failed'; reason: string };
export type WebDeployOutcome = Unrecorded | { kind: 'deployed'; record: WebDeployRecord };
export type MaintenanceOutcome =
  Unrecorded | { kind: 'deployed'; record: { action: 'maintenance recorded'; deployment: string } };

/** The project Vercel deploys into, by its ids: `team_…` and `prj_…`, nothing else. */
const IDS = {
  VERCEL_ORG_ID: /^team_[A-Za-z0-9]{1,64}$/u,
  VERCEL_PROJECT_ID: /^prj_[A-Za-z0-9]{1,64}$/u,
};
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

function vercel(args: readonly string[], env: Environment, cwd: string) {
  const result = spawnSync('vercel', args, {
    cwd,
    env: cliEnvironment(env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

/** The region list Vercel reports for a deployment, or undefined when it reports none. */
function regionsOf(answer: string): unknown {
  try {
    return (JSON.parse(answer) as { regions?: unknown } | null)?.regions;
  } catch {
    return undefined;
  }
}

/** The API function's declared runtime, or undefined when it declares none. */
function runtimeOf(output: string): string | undefined {
  try {
    const path = join(output, 'functions', 'api.func', '.vc-config.json');
    const { runtime } = JSON.parse(readFileSync(path, 'utf8')) as { runtime?: unknown };
    return typeof runtime === 'string' ? runtime : undefined;
  } catch {
    return undefined;
  }
}

/** Staging's sign-in address; a loopback stand-in in tests. */
const SIGN_IN =
  /^(?:https:\/\/[a-z]{20}\.supabase\.co|http:\/\/127\.0\.0\.1:[0-9]{1,5})\/auth\/v1$/u;
const AUTH_VERSION = /^v?[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}[0-9A-Za-z.+-]{0,40}$/u;
const HEALTH_MAX_BYTES = 4096;

/** The version the sign-in server reports: no redirect, a time limit, a size cap, its shape checked. */
async function authVersionOf(env: Environment): Promise<string | undefined> {
  const address = env['GOTRUE_URL'] ?? '';
  if (!SIGN_IN.test(address)) return undefined;
  const key = env['SUPABASE_PUBLISHABLE_KEY'] ?? '';
  try {
    const response = await fetch(`${address}/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: key === '' ? {} : { apikey: key },
    });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > HEALTH_MAX_BYTES)
      return undefined;
    const body = await response.arrayBuffer();
    if (body.byteLength > HEALTH_MAX_BYTES) return undefined;
    const { version } = JSON.parse(new TextDecoder().decode(body)) as { version?: unknown };
    return typeof version === 'string' && AUTH_VERSION.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Why the settings cannot deploy, naming each setting, never its value. */
function settingProblems(env: Environment): string[] {
  const problems = Object.entries(IDS)
    .filter(([name, shape]) => !shape.test(env[name] ?? ''))
    .map(([name]) => `${name} is not set to a Vercel id`);
  if ((env['VERCEL_TOKEN'] ?? '') !== '') {
    problems.push("VERCEL_TOKEN is set: the deploy runs under the person's own sign-in only");
  }
  return problems;
}

const refused = (why: string): Unrecorded => ({
  kind: 'refused',
  reason: `${why}. Nothing was deployed.`,
});

/** Runs `act` in a folder of its own, removed afterwards, `.vercel` and all. */
function inFolder<T>(act: (folder: string) => T): T {
  const folder = mkdtempSync(join(tmpdir(), 'ops-astro-web-deploy-'));
  try {
    return act(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** `vercel deploy --prebuilt --prod` of `folder`'s output: the deployment's own address, if any. */
function deployPrebuilt(folder: string, env: Environment): string | undefined {
  const made = vercel(['deploy', '--prebuilt', '--prod'], env, folder);
  const deployment = made.out.split('\n').at(-1) ?? '';
  return made.ok && DEPLOYMENT.test(deployment) ? deployment : undefined;
}

const NO_ADDRESS: Unrecorded = {
  kind: 'failed',
  reason: 'vercel deploy did not answer a deployment address; nothing was recorded',
};

/** The stored output copied into `folder`, checked again there, deployed and read back. */
function deployCopy(
  folder: string,
  env: Environment,
  version: string,
  selected: { path: string; name: string },
  authVersion: string,
): WebDeployOutcome {
  const { digest } = JSON.parse(readFileSync(join(selected.path, 'build.json'), 'utf8')) as {
    digest: string;
  };
  const output = join(folder, '.vercel', 'output');
  cpSync(selected.path, output, { recursive: true });
  const problems = buildOutputProblems(output);
  if (outputDigest(output) !== digest) problems.push('the copy does not hold the digested bytes');
  const runtime = runtimeOf(output);
  if (runtime === undefined) problems.push('functions/api.func declares no runtime.');
  if (problems.length > 0 || runtime === undefined) return refused(problems.join(' '));

  const deployment = deployPrebuilt(folder, env);
  if (deployment === undefined) return NO_ADDRESS;
  const inspected = vercel(['inspect', deployment, '--format', 'json'], env, folder);
  const regions = inspected.ok ? regionsOf(inspected.out) : undefined;
  if (!Array.isArray(regions) || regions.length !== 1 || regions[0] !== 'syd1') {
    return {
      kind: 'failed',
      reason: `Vercel did not report ${deployment} in syd1 alone; it is not recorded: remove it from the dashboard and look`,
    };
  }
  const record = { action: 'deploy recorded', version, artefact: selected.name, digest } as const;
  return {
    kind: 'deployed',
    record: { ...record, deployment, region: 'syd1', runtime, authVersion },
  };
}

export async function deployWeb(
  request: { version: string; store: string },
  options: { env: Environment; preflight: () => Promise<string[]> },
): Promise<WebDeployOutcome> {
  const settings = settingProblems(options.env);
  if (settings.length > 0) return refused(settings.join('; '));
  const selected = storedArtefact(request.version, request.store);
  if (typeof selected === 'string') return refused(selected);
  const signs = await options.preflight();
  if (signs.length > 0) {
    return refused(`staging's database failed the preflight: ${signs.join('; ')}`);
  }
  const authVersion = await authVersionOf(options.env);
  if (authVersion === undefined) {
    return refused('the sign-in server at GOTRUE_URL did not report its version');
  }
  return inFolder((folder) =>
    deployCopy(folder, options.env, request.version, selected, authVersion),
  );
}

/** The maintenance page to the main address: its deployment, recorded; no database is asked. */
export function deployMaintenance(options: { env: Environment }): Promise<MaintenanceOutcome> {
  const settings = settingProblems(options.env);
  if (settings.length > 0) return Promise.resolve(refused(settings.join('; ')));
  return Promise.resolve(
    inFolder((folder): MaintenanceOutcome => {
      writeMaintenanceOutput(join(folder, '.vercel', 'output'));
      const deployment = deployPrebuilt(folder, options.env);
      if (deployment === undefined) return NO_ADDRESS;
      return { kind: 'deployed', record: { action: 'maintenance recorded', deployment } };
    }),
  );
}
