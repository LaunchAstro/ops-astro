// SPDX-License-Identifier: AGPL-3.0-only
//
// The M5 deploy (ticket S0-6, `deploy recorded`): staging's unit, or
// production's with `deploy.mjs --production` (deploy/production/compose.json,
// staging's definition renamed). Each judges its own definition, preflight and
// containers, and counts the other's containers among the live services.
//
// A person's act under `operations:manage`: `deploy.mjs` asks the operator gate
// before it reads anything else. It deploys the artefact the store holds for
// the version asked, found and checked as the promotion step finds it
// (`storedArtefact`), and never builds the product itself. Before anything is
// started, staging's database must pass the made-up-only preflight
// (`productionSigns`): a sign, or no `DATABASE_ADMIN_URL` to judge it by,
// refuses the deploy.
//
// The app and API run on Vercel (`web-deploy.mjs`); this deploy starts the
// M5's unit, the worker, forwarder, backup store and egress, with no image of
// its own. Every service is named by a digest recorded in a pin row of
// docs/supply-chain-pins.md, so a moved tag changes nothing (`S0-6 image
// pins`). After Compose is up, each staging
// container must be on exactly the image it was named by; one that is not
// fails the deploy.
//
// The machine's live services are snapshotted through S0-1's service report
// before the deploy and after it, and compared with the report's own compare:
// one that stopped, restarted, vanished or changed fails the deploy (`S0-6
// services unchanged`). Only a deploy that passes both returns its record: the
// version and the artefact's name. Nothing from the environment
// and no path goes in it.
//
// Every act on the machine goes through `DeployEffects`, so the decisions are
// tested with the effects watched and the command stays thin.

import { readFileSync } from 'node:fs';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { madeUpSeedSigns, productionSigns, type OwnerQuery } from './made-up-only.ts';
import { storedArtefact } from './promotion.ts';
import { databaseProject, projectRefs, Refusal } from './staging-reset.ts';

export type DeployEnvironment = 'staging' | 'production';
type Environment = Readonly<Record<string, string | undefined>>;

/** The staging definition, as the deploy reads it. */
export interface StagingDefinition {
  'x-ops-astro': { ownPrefix: string; artefact: string };
  services: Record<string, { container_name?: string; image?: unknown; [key: string]: unknown }>;
}

/** Everything the deploy does to the machine, so a test can watch it. */
export interface DeployEffects {
  /** The service report's snapshot of the live service managers, as it prints it. */
  snapshot(): string;
  /** The service report's compare of two snapshots, leaving out the unit's own containers. */
  compare(before: string, after: string, unit: Unit): { unchanged: boolean; report: string };
  /** Compose up, waiting for health. */
  up(): void;
  /** The local image id a pinned reference resolves to, or undefined when it is not there. */
  imageId(ref: string): string | undefined;
  /** Each staging container's name and the image id it runs. */
  runningImages(): Record<string, string>;
}

/** The unit a deploy starts: its name, and whether a service (by name and manager) is its own. */
export interface Unit {
  readonly name: DeployEnvironment;
  readonly owns: (service: string, manager: string) => boolean;
}

export interface DeployRecord {
  action: 'deploy recorded';
  environment: DeployEnvironment;
  version: string;
  artefact: string;
}

export type DeployOutcome =
  { kind: 'refused' | 'failed'; reason: string } | { kind: 'deployed'; record: DeployRecord };

/** The unit's definition: staging's, or production's beside it. */
export function definitionPath(environment: DeployEnvironment): string {
  return new URL(`../../deploy/${environment}/compose.json`, import.meta.url).pathname;
}

const readDefinition = (environment: DeployEnvironment): StagingDefinition =>
  JSON.parse(readFileSync(definitionPath(environment), 'utf8')) as StagingDefinition;
const STAGING_PREFIX = readDefinition('staging')['x-ops-astro'].ownPrefix;

/**
 * The unit's own services, which its deploy may restart: staging's by its
 * prefix, as the service report has always judged; production's only the
 * Docker containers its Compose definition names, so a launchd job or any
 * other `ops-astro-*` service stays a live one.
 */
export function unitOf(environment: DeployEnvironment): Unit {
  if (environment === 'staging')
    return { name: environment, owns: (name) => name.startsWith(STAGING_PREFIX) };
  const containers = new Set(
    Object.entries(readDefinition(environment).services).map(([key, s]) => s.container_name ?? key),
  );
  return {
    name: environment,
    owns: (name, manager) => manager === 'docker' && containers.has(name),
  };
}
const pinRecord = readFileSync(new URL('../../docs/supply-chain-pins.md', import.meta.url), 'utf8');

/** `repository:tag@sha256:digest`, lower-case, nothing around it. */
const PINNED =
  /^(?<repo>[a-z0-9]+(?:[._/-][a-z0-9]+)*):(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})@sha256:(?<digest>[0-9a-f]{64})$/u;
/** A pin row: repository, tag and digest, each in its own code cell. */
const PIN_ROW =
  /^\|\s*`(?<repo>[^`]+)`\s*\|\s*`(?<tag>[^`]+)`\s*\|\s*`sha256:(?<digest>[0-9a-f]{64})`\s*\|/u;
/** Keys that let Compose build or choose an image other than the one named. */
const UNPINNED_KEYS = ['build', 'platform', 'pull_policy'];

/** Every pin the record's rows hold, as `repository:tag@sha256:digest`. */
function recordedPins(record: string): Set<string> {
  const pins = new Set<string>();
  for (const line of record.split(/\r?\n/u)) {
    const row = PIN_ROW.exec(line)?.groups;
    if (row) pins.add(`${row['repo']}:${row['tag']}@sha256:${row['digest']}`);
  }
  return pins;
}

/** Why each service is not named by a recorded digest; empty when all are. */
export function imagePinProblems(def: StagingDefinition, record: string): string[] {
  const pins = recordedPins(record);
  const problems: string[] = [];
  for (const [name, service] of Object.entries(def.services)) {
    const key = UNPINNED_KEYS.find((k) => k in service);
    const image = service.image;
    if (key !== undefined) problems.push(`${name}: \`${key}\` lets Compose run another image`);
    else if (typeof image !== 'string' || !PINNED.test(image)) {
      problems.push(`${name}: not named repository:tag@sha256:digest`);
    } else if (!pins.has(image)) {
      problems.push(`${name}: ${image} has no pin row in docs/supply-chain-pins.md`);
    }
  }
  return problems;
}

/** `judge` on the database `DATABASE_ADMIN_URL` names: its signs, or why it could not judge. */
async function preflightOn(judge: (admin: OwnerQuery) => Promise<string[]>): Promise<string[]> {
  const url = process.env['DATABASE_ADMIN_URL'] ?? '';
  if (url === '') return ['DATABASE_ADMIN_URL is not set, so the preflight could not run'];
  const admin = connectAsAdmin(url, { source: 'preflight' });
  try {
    return await judge(admin);
  } finally {
    await admin.close();
  }
}

/** Staging's preflight: the made-up-only judgement. */
export function stagingSigns(): Promise<string[]> {
  return preflightOn(productionSigns);
}

/**
 * Why `DATABASE_ADMIN_URL` is not production's database: on staging's project,
 * or on any but production's (PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF).
 */
export function productionAddressRefusal(env: Environment): string | undefined {
  try {
    const { other, ref, otherRef } = projectRefs(env, true);
    const project = databaseProject('DATABASE_ADMIN_URL', env['DATABASE_ADMIN_URL'] ?? '');
    if (project === otherRef) return `DATABASE_ADMIN_URL reaches ${other}'s project`;
    return project === ref ? undefined : "DATABASE_ADMIN_URL is not production's project";
  } catch (error) {
    if (error instanceof Refusal) return error.message;
    throw error;
  }
}

/** Production's preflight: its own database, and no sign that the made-up seed ever ran there. */
export function productionPreflight(): Promise<string[]> {
  const refusal = productionAddressRefusal(process.env);
  return refusal === undefined ? preflightOn(madeUpSeedSigns) : Promise.resolve([refusal]);
}

/** Each environment's own preflight. */
export function preflightFor(environment: DeployEnvironment): () => Promise<string[]> {
  return environment === 'production' ? productionPreflight : stagingSigns;
}

/** Each of the unit's containers not on the image it was named by. */
function imageProblems(effects: DeployEffects, definition: StagingDefinition): string[] {
  const problems: string[] = [];
  const running = effects.runningImages();
  for (const [name, service] of Object.entries(definition.services)) {
    const container = service.container_name ?? name;
    const named = String(service.image);
    const wanted = effects.imageId(named);
    if (wanted === undefined) problems.push(`${named} is not there to inspect`);
    else if (running[container] !== wanted) {
      problems.push(`${container} runs ${running[container] ?? 'nothing'}, not ${named}`);
    }
  }
  return problems;
}

export async function deploy(
  request: { version: string; store: string },
  effects: DeployEffects,
  preflight?: () => Promise<string[]>,
  environment: DeployEnvironment = 'staging',
): Promise<DeployOutcome> {
  const selected = storedArtefact(request.version, request.store);
  if (typeof selected === 'string') return { kind: 'refused', reason: selected };
  const definition = readDefinition(environment);
  const pins = imagePinProblems(definition, pinRecord);
  if (pins.length > 0) {
    return {
      kind: 'refused',
      reason: `${environment}'s images are not all pinned: ${pins.join('; ')}. Nothing was deployed.`,
    };
  }

  const signs = await (preflight ?? preflightFor(environment))();
  if (signs.length > 0) {
    return {
      kind: 'refused',
      reason: `${environment}'s database failed the preflight: ${signs.join('; ')}. Nothing was started.`,
    };
  }

  const before = effects.snapshot();
  effects.up();

  const problems = imageProblems(effects, definition);
  const compared = effects.compare(before, effects.snapshot(), unitOf(environment));
  if (!compared.unchanged) problems.push(`a live service changed:\n${compared.report}`);
  if (problems.length > 0) {
    const unit = environment === 'staging' ? 'Staging' : 'Production';
    return {
      kind: 'failed',
      reason: `${problems.join('; ')}. ${unit} is up but this deploy is not recorded. Stop it with docker compose down, then find out why.`,
    };
  }
  const record = { action: 'deploy recorded', environment, version: request.version } as const;
  return { kind: 'deployed', record: { ...record, artefact: selected.name } };
}
