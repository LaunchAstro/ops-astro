// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging web deploy on Vercel (ticket S0-6, `deploy recorded`; the Vercel
// re-plan, section 11 step 4), and production's with `--production`. It sits
// beside `deploy.ts`, which still starts the machine's own containers.
//
// A person's act under `operations:manage`: `web-deploy.mjs` asks the operator
// gate first. This takes the build output the store holds for the version
// asked (`storedArtefact`: a clean build, its stamp, its digest), copies it into
// a folder of its own as `.vercel/output`, and checks the copy again (the same
// digest, `buildOutputProblems`), so the bytes Vercel is handed are the ones
// checked. Staging's database must pass the made-up-only preflight first.
// Production's deploy takes only the bytes staging ran (`stagedArtefact`, #970):
// the digest must be the one staging's web deploy recorded for the version in
// the operator's record folder, so a store writer's self-consistent tree is
// refused before the database or Vercel is asked. Vercel is asked only under
// the operator's held grant, the gate asked again first (`authorised`), and
// the record is judged again just before and once more after.
//
// Vercel is asked twice, through the person's own `vercel` sign-in, never a
// token: `vercel deploy --prebuilt --prod` (its answer on stdout is the new
// deployment's own address) and `vercel inspect <address> --format json`, which
// must report that same address `READY` on `production`. Only its url, target
// and readyState are read. Vercel CLI 54.17.3 prints id, name, url, target,
// readyState, createdAt and, when present, aliases, builds, routes and
// contextName; a reported build's lambda output can name the regions it was
// deployed to (`deployedTo`), but that is not read. The region recorded is the
// one the built output declares: `buildOutputProblems` has already held every
// function to `syd1` alone (`S0-6 functions in Sydney`), so `syd1` is a
// declaration checked before the deploy, not a region Vercel reported back.
// The CLI gets only PATH, HOME, TMPDIR and the two project ids, so no sign-in
// value or database login reaches it. The folder, `.vercel` and all, is
// removed whatever happens.
//
// Before Vercel is asked, the sign-in server reports its version (`/health`
// under GOTRUE_URL, staging's own sign-in address, with the publishable key
// when set); no answer, no deploy. Only a deploy read back ready on production
// returns its record: the version, the artefact, the digest, the deployment,
// the region, the function runtime and the sign-in server's version (`S0-6
// image pins`).
//
// The maintenance page (`deployMaintenance`, `maintenance.ts`) goes out the
// same prebuilt way, with no database asked, so a broken database never keeps
// it off; it holds no function, so it declares no region, and it is recorded
// on the deploy's answer alone, without `vercel inspect`. Deploying a version
// again takes it off.
//
// Production's deploy makes every check above but made-up-only, which its real
// sign-ins would fail: first DATABASE_ADMIN_URL and GOTRUE_URL must be
// production's project, never staging's, and its preflight is production's own
// (`deploy.ts`). The record names the environment.

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authVersionOf } from './auth-version.ts';
import { buildOutputProblems } from './build-output.ts';
import { writeMaintenanceOutput } from './maintenance.ts';
import { type Authorised, heldFor } from './authorised-act.ts';
import { notStillStaged } from './deployment-record.ts';
import { type StoredArtefact, stagedArtefact, storedArtefact } from './promotion.ts';
import { holds } from './served-copy.ts';
import { deployPrebuilt, readBack } from './vercel-cli.ts';
import { type DeployEnvironment, productionAddressRefusal } from './deploy.ts';

type Environment = Readonly<Record<string, string | undefined>>;

export interface WebDeployRecord {
  readonly action: 'deploy recorded';
  readonly environment: DeployEnvironment;
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

/** Production's addresses: its database and sign-in on its own project, never staging's. */
function productionProblems(env: Environment): string[] {
  const refusal = productionAddressRefusal(env);
  if (refusal !== undefined) return [refusal];
  return env['GOTRUE_URL'] === `https://${env['PRODUCTION_PROJECT_REF'] ?? ''}.supabase.co/auth/v1`
    ? []
    : ["GOTRUE_URL is not production's sign-in"];
}

const refused = (why: string): Unrecorded => ({
  kind: 'refused',
  reason: `${why}. Nothing was deployed.`,
});

/** Runs `act` in a folder of its own, removed afterwards, `.vercel` and all. */
async function inFolder<T>(act: (folder: string) => T | Promise<T>): Promise<T> {
  const folder = mkdtempSync(join(tmpdir(), 'ops-astro-web-deploy-'));
  try {
    return await act(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const NO_ADDRESS: Unrecorded = {
  kind: 'failed',
  reason: 'vercel deploy did not answer a deployment address; nothing was recorded',
};

/** What the deploy runs under: the operator's held grant, and staging's record judged again. */
interface Held {
  readonly authorised: Authorised;
  /** Why staging's record no longer holds the selected digest, or undefined while it does. */
  readonly changed: () => string | undefined;
}

/** The stored output copied into `folder`, checked again there, deployed and read back. */
async function deployCopy(
  folder: string,
  env: Environment,
  { version, environment }: { version: string; environment: DeployEnvironment },
  selected: StoredArtefact,
  authVersion: string,
  held: Held,
): Promise<WebDeployOutcome> {
  const { digest } = selected;
  const output = join(folder, '.vercel', 'output');
  cpSync(selected.path, output, { recursive: true });
  const problems = buildOutputProblems(output);
  // A real folder: an artefact swapped for a link since selection copies as a link.
  if (!holds(output, digest)) problems.push('the copy does not hold the digested bytes');
  const runtime = runtimeOf(output);
  if (runtime === undefined) problems.push('functions/api.func declares no runtime.');
  if (problems.length > 0 || runtime === undefined) return refused(problems.join(' '));
  const record = {
    action: 'deploy recorded',
    environment,
    version,
    artefact: selected.name,
    digest,
  } as const;
  const answer = await heldFor(held.authorised, (): WebDeployOutcome => {
    // Judged again after every wait, as the last step before Vercel is asked (#970).
    const before = held.changed();
    if (before !== undefined)
      return refused(`staging's record changed before the deploy: ${before}`);
    const deployment = deployPrebuilt(folder, env);
    if (deployment === undefined) return NO_ADDRESS;
    const read = readBack(folder, env, deployment);
    if (read !== undefined) return read;
    const after = held.changed();
    if (after !== undefined) {
      const reason = `${deployment} is live on production with ${digest}, but staging's record changed during the deploy: ${after}. It is not recorded; settle staging's record, then deploy again.`;
      return { kind: 'failed', reason };
    }
    return {
      kind: 'deployed',
      record: { ...record, deployment, region: 'syd1', runtime, authVersion },
    };
  });
  return 'refused' in answer ? refused(answer.refused) : answer.ran;
}

export async function deployWeb(
  request: { version: string; store: string },
  options: {
    env: Environment;
    preflight: () => Promise<string[]>;
    environment?: DeployEnvironment;
    /** Staging's record folder (OPS_ASTRO_DEPLOYMENTS); production deploys only the digest it holds. */
    records?: string;
    /** The operator's held grant, under which Vercel is asked; production refuses without it. */
    authorised?: Authorised;
  },
): Promise<WebDeployOutcome> {
  const environment = options.environment ?? 'staging';
  const production = environment === 'production';
  const settings = settingProblems(options.env);
  if (production) settings.push(...productionProblems(options.env));
  if (production && options.authorised === undefined) {
    settings.push("a production deploy runs only under the operator's held grant");
  }
  if (settings.length > 0) return refused(settings.join('; '));
  const records = options.records ?? '';
  const selected = production
    ? stagedArtefact(request.version, request.store, records)
    : storedArtefact(request.version, request.store);
  if (typeof selected === 'string') return refused(selected);
  const signs = await options.preflight();
  if (signs.length > 0) {
    return refused(`${environment}'s database failed the preflight: ${signs.join('; ')}`);
  }
  const authVersion = await authVersionOf(options.env);
  if (authVersion === undefined) {
    return refused('the sign-in server at GOTRUE_URL did not report its version');
  }
  const held: Held = {
    authorised: options.authorised ?? (async (work) => await work()),
    changed: () =>
      production ? notStillStaged(records, request.version, selected.digest) : undefined,
  };
  return await inFolder(
    async (folder) =>
      await deployCopy(
        folder,
        options.env,
        { version: request.version, environment },
        selected,
        authVersion,
        held,
      ),
  );
}

/** The maintenance page to the main address: its deployment, recorded; no database is asked. */
export function deployMaintenance(options: { env: Environment }): Promise<MaintenanceOutcome> {
  const settings = settingProblems(options.env);
  if (settings.length > 0) return Promise.resolve(refused(settings.join('; ')));
  return inFolder((folder): MaintenanceOutcome => {
    writeMaintenanceOutput(join(folder, '.vercel', 'output'));
    const deployment = deployPrebuilt(folder, options.env);
    if (deployment === undefined) return NO_ADDRESS;
    return { kind: 'deployed', record: { action: 'maintenance recorded', deployment } };
  });
}
