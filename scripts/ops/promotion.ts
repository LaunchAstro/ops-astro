// SPDX-License-Identifier: AGPL-3.0-only
//
// The promotion step (ticket S0-1, lines C3 and C10).
//
// Production gets the exact artefact staging ran, never a fresh build. The
// artefact is found in the store by the name the staging definition gives it
// (`x-ops-astro.artefact` in deploy/staging/compose.json), and its own stamp,
// the `build.json` every build writes into itself (S0-1c), must name the same
// version. A build from a dirty tree names no commit, so it is not promoted.
//
// Before it migrates, the step asks the service manager whether the API and
// the auth server are stopped, and refuses while either runs. Open connections
// cannot tell a stopped app from an idle one: an idle app holds none. The
// migration runner's own refusal while other sessions are connected stays as
// the backstop behind this (scripts/db-migrate.mjs).
//
// With both stopped it migrates, points production at the artefact and starts
// the auth server, then the API. A migration that fails promotes nothing and
// starts nothing, so the old build never runs against a half-moved schema.
//
// Every act on the machine goes through `PromotionEffects`, so the decisions
// here are tested with the effects watched and the command stays thin.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A service as the service manager names it. */
export interface ServiceRef {
  manager: 'docker' | 'launchd';
  name: string;
}

/** What the service manager says about one service. */
export interface ServiceState extends ServiceRef {
  running: boolean;
}

/** What the promotion records: the version and the owner's one line. */
export interface PromotionRecord {
  action: 'promotion recorded';
  version: string;
  artefact: string;
  line: string;
  dryRun: boolean;
}

export interface PromotionRequest {
  /** The build identifier staging ran, as its page showed it. */
  version: string;
  /** The directory holding one artefact directory per build. */
  store: string;
  /** The owner's one line that they tried this build on staging. */
  line: string;
  dryRun: boolean;
  api?: ServiceRef;
  auth?: ServiceRef;
  /** The link production serves from, pointed at the artefact. */
  current?: string;
}

/** Everything the step does to the machine, so a test can watch it. */
export interface PromotionEffects {
  services(): readonly ServiceState[];
  migrate(): boolean;
  point(current: string, artefact: string): void;
  start(service: ServiceRef): void;
}

export type PromotionOutcome =
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'dry-run' | 'promoted'; record: PromotionRecord; artefactPath: string };

/** A promotable build identifier: S0-1c's stamp, without `-dirty`. */
const CLEAN_BUILD = /^[0-9a-f]{12}$/u;
/** The file S0-1c's build writes into its artefact. */
const STAMP_FILE = 'build.json';
const LONGEST_LINE = 200;
const SERVICE = /^(?<manager>docker|launchd):(?<name>[A-Za-z0-9][A-Za-z0-9_.-]*)$/u;

const definition = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
) as { 'x-ops-astro': { artefact: string } };

/** The artefact's name for one version, as the staging definition gives it. */
export function artefactName(version: string): string {
  return definition['x-ops-astro'].artefact.replace('{version}', version);
}

/** Parse `docker:<name>` or `launchd:<label>`. */
export function parseService(text: string): ServiceRef {
  const match = SERVICE.exec(text);
  if (!match?.groups)
    throw new Error(`${text} names no service: use docker:<name> or launchd:<label>`);
  return { manager: match.groups['manager'] as ServiceRef['manager'], name: match.groups['name']! };
}

const label = (service: ServiceRef): string => `${service.manager}:${service.name}`;

/** The stamp an artefact carries, or undefined when it has none. */
function stampOf(directory: string): string | undefined {
  try {
    const build = (
      JSON.parse(readFileSync(join(directory, STAMP_FILE), 'utf8')) as { build?: unknown }
    ).build;
    return typeof build === 'string' ? build : undefined;
  } catch {
    return undefined;
  }
}

/** The artefact staging ran, or why it cannot be promoted. */
function select(request: PromotionRequest): { path: string; name: string } | string {
  if (!CLEAN_BUILD.test(request.version)) {
    return `${request.version} is not a clean build identifier (twelve hex digits, never -dirty)`;
  }
  const lines = request.line.split(/\r?\n|\r/u);
  if (lines.length !== 1 || request.line.trim() === '' || request.line.length > LONGEST_LINE) {
    return `the owner's one line that they tried this build on staging is needed: one line, at most ${LONGEST_LINE} characters`;
  }
  const name = artefactName(request.version);
  const path = join(request.store, name);
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    // Not there is refused below, the same as not a directory.
  }
  if (!isDirectory) return `no artefact ${name} in ${request.store}; the step never builds one`;
  const carried = stampOf(path);
  if (carried !== request.version) {
    return `${name} carries ${carried ?? 'no stamp'}, not ${request.version}; production gets the build staging ran, never another`;
  }
  return { path, name };
}

export function promote(request: PromotionRequest, effects: PromotionEffects): PromotionOutcome {
  const selected = select(request);
  if (typeof selected === 'string') return { kind: 'refused', reason: selected };
  const record: PromotionRecord = {
    action: 'promotion recorded',
    version: request.version,
    artefact: selected.name,
    line: request.line,
    dryRun: request.dryRun,
  };
  if (request.dryRun) return { kind: 'dry-run', record, artefactPath: selected.path };

  const { api, auth, current } = request;
  if (!api || !auth || !current) {
    return {
      kind: 'refused',
      reason: 'a promotion needs the API, the auth server and the production link named',
    };
  }
  const states = effects.services();
  const problems = [api, auth].flatMap((wanted) => {
    const found = states.find((s) => s.manager === wanted.manager && s.name === wanted.name);
    if (!found)
      return [`the service manager cannot find ${label(wanted)}, so it cannot say it is stopped`];
    return found.running ? [`${label(wanted)} is running`] : [];
  });
  if (problems.length > 0) {
    return {
      kind: 'refused',
      reason: `${problems.join('; ')}. Stop the API and the auth server with the service manager, then run the promotion again. Nothing was migrated or promoted.`,
    };
  }

  if (!effects.migrate()) {
    return {
      kind: 'failed',
      reason: `the migration did not complete; nothing was promoted and the API and the auth server are left stopped`,
    };
  }
  effects.point(current, selected.path);
  effects.start(auth);
  effects.start(api);
  return { kind: 'promoted', record, artefactPath: selected.path };
}
