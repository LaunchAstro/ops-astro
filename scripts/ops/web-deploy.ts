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
// under GOTRUE_URL, staging's own sign-in address, with the publishable key,
// whose setting is refused up front when unset); no answer, no deploy. Only a
// deploy read back ready on production returns its record: the version, the
// artefact, the digest, the deployment, the region, the function runtime and
// the sign-in server's version (`S0-6 image pins`).
//
// The maintenance page (`deployMaintenance`, `maintenance.ts`) goes out the
// same prebuilt way, with no database asked, so a broken database never keeps
// it off; it holds no function, so it declares no region, and it is recorded
// on the deploy's answer alone, without `vercel inspect`. Deploying a version
// again takes it off. A planned maintenance names that version and first runs
// its deploy's own checks (`version-checks.ts`), so the page goes up only if
// that deploy could run now (#1985); the bare form says it ran none.
//
// Production's deploy makes every check above but made-up-only, which its real
// sign-ins would fail: first DATABASE_ADMIN_URL and GOTRUE_URL must be
// production's project, never staging's, and its preflight is production's own
// (`deploy.ts`). The record names the environment.

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOutputProblems } from './build-output.ts';
import { writeMaintenanceOutput } from './maintenance.ts';
import { type Authorised, heldFor } from './authorised-act.ts';
import { notStillStaged } from './deployment-record.ts';
import type { StoredArtefact } from './promotion.ts';
import { holds } from './served-copy.ts';
import { deployPrebuilt, readBack } from './vercel-cli.ts';
import type { DeployEnvironment } from './deploy.ts';
import {
  settingProblems,
  type VersionDeployOptions,
  type VersionRequest,
  versionReady,
} from './version-checks.ts';

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
  | Unrecorded
  | {
      kind: 'deployed';
      record: { action: 'maintenance recorded'; deployment: string };
      /** Set on the bare form: the version deploy after it was not checked. */
      unchecked?: string;
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
  request: VersionRequest,
  options: VersionDeployOptions,
): Promise<WebDeployOutcome> {
  const ready = await versionReady(request, options);
  if (typeof ready === 'string') return refused(ready);
  const environment = options.environment ?? 'staging';
  const { selected, authVersion } = ready;
  const held: Held = {
    authorised: options.authorised ?? (async (work) => await work()),
    changed: () =>
      environment === 'production'
        ? notStillStaged(options.records ?? '', request.version, selected.digest)
        : undefined,
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

const UNCHECKED =
  'no version was named, so the deploy that takes the page off was not checked; outside an incident, name it with --version and --artefacts';

/**
 * The maintenance page to the main address: its deployment, recorded; no
 * database is asked. Planned, it first runs the checks of the version deploy
 * that takes it off, and goes up only if that deploy could run now.
 */
export async function deployMaintenance(
  options: { env: Environment },
  planned?: { request: VersionRequest; options: VersionDeployOptions },
): Promise<MaintenanceOutcome> {
  const settings = settingProblems(options.env);
  if (settings.length > 0) return refused(settings.join('; '));
  if (planned !== undefined) {
    const ready = await versionReady(planned.request, planned.options);
    if (typeof ready === 'string') {
      return refused(
        `the deploy of ${planned.request.version} that takes the page off would be refused: ${ready}`,
      );
    }
  }
  return await inFolder((folder): MaintenanceOutcome => {
    writeMaintenanceOutput(join(folder, '.vercel', 'output'));
    const deployment = deployPrebuilt(folder, options.env);
    if (deployment === undefined) return NO_ADDRESS;
    const record = { action: 'maintenance recorded', deployment } as const;
    return planned === undefined
      ? { kind: 'deployed', record, unchecked: UNCHECKED }
      : { kind: 'deployed', record };
  });
}
