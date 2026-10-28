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
// again takes it off. A planned maintenance names that version and runs its
// deploy up to Vercel (`asVersionDeploy`: the checks in `version-checks.ts`,
// the copy checked again, the held grant, staging's record judged again), so
// the page goes up only if that deploy could run now (#1985); the bare form
// says it ran none.
//
// Production's deploy makes every check above but made-up-only, which its real
// sign-ins would fail: first DATABASE_ADMIN_URL and GOTRUE_URL must be
// production's project, never staging's, and its preflight is production's own
// (`deploy.ts`). The record names the environment.
//
// With staging off by the owner's decision (`stagingOff`, #2285), the digest
// the release step recorded for the version stands in for staging's, judged
// at the same points, and the record says staging's was waived and by which
// decision. Every other check is the same.
//
// After production's rollback (`web-rollback.ts`, #2299) Vercel gives later
// deployments no domain until one is promoted, so production's next deploy
// runs `vercel promote` once read back, and the maintenance page on
// production is refused until then.

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOutputProblems } from './build-output.ts';
import { writeMaintenanceOutput } from './maintenance.ts';
import { heldFor } from './authorised-act.ts';
import { notStillStaged, recordName, rolledBack } from './deployment-record.ts';
import type { StoredArtefact } from './promotion.ts';
import { holds } from './served-copy.ts';
import { deployPrebuilt, promote, readBack } from './vercel-cli.ts';
import type { DeployEnvironment } from './deploy.ts';
import {
  recordSource,
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
  /** Set with staging off: staging's record was waived by the owner's decision named. */
  readonly stagingRecord?: 'waived';
  readonly waivedBy?: string;
}

export type Unrecorded = { kind: 'refused' | 'failed'; reason: string };
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

export const refused = (why: string): Unrecorded => ({
  kind: 'refused',
  reason: `${why}. Nothing was deployed.`,
});

/** Runs `act` in a folder of its own, removed afterwards, `.vercel` and all. */
export async function inFolder<T>(act: (folder: string) => T | Promise<T>): Promise<T> {
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

/** The version's output as its deploy holds it, the moment before Vercel is asked. */
interface Checked {
  readonly folder: string;
  readonly selected: StoredArtefact;
  readonly runtime: string;
  readonly authVersion: string;
  /** Why staging's record no longer holds the selected digest, or undefined while it does. */
  readonly changed: () => string | undefined;
}

/**
 * The version deploy up to Vercel: its checks (`versionReady`), the stored
 * output copied into a folder of its own and checked again there, then `act`
 * under the operator's held grant once staging's record is judged again. A
 * planned maintenance runs the same, with the page as its act.
 */
async function asVersionDeploy<T>(
  request: VersionRequest,
  options: VersionDeployOptions,
  act: (checked: Checked) => T | Unrecorded | Promise<T | Unrecorded>,
): Promise<T | Unrecorded> {
  const ready = await versionReady(request, options);
  if (typeof ready === 'string') return refused(ready);
  const { selected, authVersion } = ready;
  const source = recordSource(options);
  const changed = (): string | undefined =>
    options.environment === 'production'
      ? notStillStaged(options.records ?? '', request.version, selected.digest, source)
      : undefined;
  const authorised = options.authorised ?? (async (work) => await work());
  return await inFolder(async (folder) => {
    const output = join(folder, '.vercel', 'output');
    cpSync(selected.path, output, { recursive: true });
    const problems = buildOutputProblems(output);
    // A real folder: an artefact swapped for a link since selection copies as a link.
    if (!holds(output, selected.digest)) problems.push('the copy does not hold the digested bytes');
    const runtime = runtimeOf(output);
    if (runtime === undefined) problems.push('functions/api.func declares no runtime.');
    if (problems.length > 0 || runtime === undefined) return refused(problems.join(' '));
    const answer = await heldFor(authorised, async () => {
      // Judged again after every wait, as the last step before Vercel is asked (#970).
      const before = changed();
      if (before !== undefined)
        return refused(`${recordName(source)} changed before the deploy: ${before}`);
      return await act({ folder, selected, runtime, authVersion, changed });
    });
    return 'refused' in answer ? refused(answer.refused) : answer.ran;
  });
}

export async function deployWeb(
  request: VersionRequest,
  options: VersionDeployOptions,
): Promise<WebDeployOutcome> {
  const environment = options.environment ?? 'staging';
  const { env, stagingOff } = options;
  const waived =
    stagingOff === undefined ? {} : ({ stagingRecord: 'waived', waivedBy: stagingOff } as const);
  const name = recordName(recordSource(options));
  return await asVersionDeploy(
    request,
    options,
    ({ folder, selected, runtime, authVersion, changed }): WebDeployOutcome => {
      const { digest } = selected;
      const promoting = environment === 'production' && rolledBack(options.records ?? '');
      if (typeof promoting === 'object') return refused(promoting.why);
      const deployment = deployPrebuilt(folder, env);
      if (deployment === undefined) return NO_ADDRESS;
      const read = readBack(folder, env, deployment);
      if (read !== undefined) return read;
      const after = changed();
      if (after !== undefined) {
        const reason = `${deployment} is live on production with ${digest}, but ${name} changed during the deploy: ${after}. It is not recorded; settle ${name}, then deploy again.`;
        return { kind: 'failed', reason };
      }
      const unpromoted = promoting ? promote(folder, env, deployment) : undefined;
      if (unpromoted !== undefined) return unpromoted;
      const record = {
        action: 'deploy recorded',
        environment,
        version: request.version,
        artefact: selected.name,
        digest,
        deployment,
        region: 'syd1',
        runtime,
        authVersion,
        ...waived,
      } as const;
      return { kind: 'deployed', record };
    },
  );
}

const ROLLED_BACK =
  'production was rolled back since its last deploy, and Vercel gives the page no domain until a deploy is promoted: deploy a version first, which promotes itself';

/** The page's refusal while production's record (`records`) holds a rollback not yet promoted past. */
function rollbackPending(records: string | undefined): Unrecorded | undefined {
  const rolled = records === undefined ? false : rolledBack(records);
  return rolled === false ? undefined : refused(rolled === true ? ROLLED_BACK : rolled.why);
}

const UNCHECKED =
  'no version was named, so the deploy that takes the page off was not checked; outside an incident, name it with --version and --artefacts';

/** The maintenance page, deployed from a folder of its own: its deployment, or no address. */
function maintenancePage(env: Environment): Promise<MaintenanceOutcome> {
  return inFolder((folder): MaintenanceOutcome => {
    writeMaintenanceOutput(join(folder, '.vercel', 'output'));
    const deployment = deployPrebuilt(folder, env);
    if (deployment === undefined) return NO_ADDRESS;
    return { kind: 'deployed', record: { action: 'maintenance recorded', deployment } };
  });
}

/**
 * The maintenance page to the main address: its deployment, recorded; no
 * database is asked. On production (`rolledBackIn`, the record folder) it is
 * refused after a recorded rollback, until a deploy has promoted (#2299).
 * Planned, it runs the version deploy that takes it off up to Vercel
 * (`asVersionDeploy`), and the page, not the version, is what Vercel is then
 * asked to take.
 */
export async function deployMaintenance(
  options: { env: Environment; rolledBackIn?: string },
  planned?: { request: VersionRequest; options: VersionDeployOptions },
): Promise<MaintenanceOutcome> {
  const settings = settingProblems(options.env);
  if (settings.length > 0) return refused(settings.join('; '));
  const rolled = rollbackPending(options.rolledBackIn);
  if (rolled !== undefined) return rolled;
  if (planned === undefined) {
    const outcome = await maintenancePage(options.env);
    return outcome.kind === 'deployed' ? { ...outcome, unchecked: UNCHECKED } : outcome;
  }
  let late: Unrecorded | undefined;
  const outcome = await asVersionDeploy(planned.request, planned.options, async () => {
    // Judged again under the held grant, after the checks' waits (#2299).
    late = rollbackPending(options.rolledBackIn);
    return late ?? (await maintenancePage(options.env));
  });
  if (outcome.kind !== 'refused' || late !== undefined) return outcome;
  const { version } = planned.request;
  const reason = `the deploy of ${version} that takes the page off would be refused: ${outcome.reason}`;
  return { kind: 'refused', reason };
}
