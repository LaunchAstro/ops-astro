// SPDX-License-Identifier: AGPL-3.0-only
//
// The version deploy's checks before Vercel is asked (`web-deploy.ts`), in its
// order: the settings, the artefact selected, the database preflight and the
// sign-in server's version. The deploy runs them, and so does a planned
// maintenance, so the page goes up only if the version that takes it off
// could deploy now (#1985). Each refusal names a setting or a problem, never
// a value. `--staging-off` changes only whose record ties the bytes to the
// build, and only on production (#2285).

import { authVersionOf } from './auth-version.ts';
import type { Authorised } from './authorised-act.ts';
import type { RecordSource } from './deployment-record.ts';
import { type DeployEnvironment, productionAddressRefusal } from './deploy.ts';
import { type StoredArtefact, stagedArtefact, storedArtefact } from './promotion.ts';

type Environment = Readonly<Record<string, string | undefined>>;

/** The project Vercel deploys into, by its ids: `team_…` and `prj_…`, nothing else. */
const IDS = {
  VERCEL_ORG_ID: /^team_[A-Za-z0-9]{1,64}$/u,
  VERCEL_PROJECT_ID: /^prj_[A-Za-z0-9]{1,64}$/u,
};

/** Why the settings cannot deploy, naming each setting, never its value. */
export function settingProblems(env: Environment): string[] {
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

/** The owner's decision a staging-off deploy names: one short line, recorded as given. */
const DECISION = /^[A-Za-z0-9][A-Za-z0-9 ,.:#/_-]{0,99}$/u;

/** Whose record ties a deploy's bytes to its build: the release step's with staging off. */
export const recordSource = (options: VersionDeployOptions): RecordSource =>
  options.stagingOff === undefined ? 'staging' : 'release';

/** What a version deploy is asked for: the version and the store holding its artefact. */
export interface VersionRequest {
  readonly version: string;
  readonly store: string;
}

/** How a version deploy runs; a planned maintenance checks the same options. */
export interface VersionDeployOptions {
  env: Environment;
  preflight: () => Promise<string[]>;
  environment?: DeployEnvironment;
  /** Staging's record folder (OPS_ASTRO_DEPLOYMENTS); production deploys only the digest it holds. */
  records?: string;
  /** The operator's held grant, under which Vercel is asked; production refuses without it. */
  authorised?: Authorised;
  /**
   * The owner's decision that turned staging off (`--staging-off`), production's
   * alone: the digest the release step recorded stands in for staging's (#2285).
   */
  stagingOff?: string;
}

/** What the version deploy takes once every check before Vercel has passed. */
export interface Ready {
  readonly selected: StoredArtefact;
  readonly authVersion: string;
}

/**
 * The version deploy's checks before Vercel, in its order: the settings, the
 * artefact selected, the database preflight, the sign-in server's version.
 * The first failure's reason, or what the deploy takes.
 */
export async function versionReady(
  request: VersionRequest,
  options: VersionDeployOptions,
): Promise<string | Ready> {
  const environment = options.environment ?? 'staging';
  const production = environment === 'production';
  const settings = settingProblems(options.env);
  if ((options.env['SUPABASE_PUBLISHABLE_KEY'] ?? '') === '') {
    settings.push(
      "SUPABASE_PUBLISHABLE_KEY is not set: the sign-in server's version is read with it",
    );
  }
  if (production) settings.push(...productionProblems(options.env));
  if (production && options.authorised === undefined) {
    settings.push("a production deploy runs only under the operator's held grant");
  }
  const off = options.stagingOff;
  if (off !== undefined && !production)
    settings.push('--staging-off is for a production deploy alone');
  if (off !== undefined && !DECISION.test(off)) {
    settings.push(
      "--staging-off names the owner's decision: one line of at most 100 letters, digits, spaces and , . : # / _ -",
    );
  }
  if (settings.length > 0) return settings.join('; ');
  const selected = production
    ? stagedArtefact(request.version, request.store, options.records ?? '', recordSource(options))
    : storedArtefact(request.version, request.store);
  if (typeof selected === 'string') return selected;
  const signs = await options.preflight();
  if (signs.length > 0)
    return `${environment}'s database failed the preflight: ${signs.join('; ')}`;
  const authVersion = await authVersionOf(options.env);
  if (authVersion === undefined)
    return 'the sign-in server at GOTRUE_URL did not report its version';
  return { selected, authVersion };
}
