// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging deploy (ticket S0-6, `deploy recorded`).
//
// A person's act under `operations:manage`: `deploy.mjs` asks the operator gate
// before it reads anything else. It deploys the artefact the store holds for
// the version asked, found and checked as the promotion step finds it
// (`storedArtefact`), and never builds the product itself.
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
//
// Before anything is started, staging's database must pass the made-up-only
// preflight (`productionSigns`, the owner's option A, NATHAN-GUARD-A): a sign,
// or no `DATABASE_ADMIN_URL` to judge it by, refuses the deploy.

import { readFileSync } from 'node:fs';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { productionSigns } from './made-up-only.ts';
import { storedArtefact } from './promotion.ts';

/** The staging definition, as the deploy reads it. */
export interface StagingDefinition {
  'x-ops-astro': { ownPrefix: string; artefact: string };
  services: Record<string, { container_name?: string; image?: unknown; [key: string]: unknown }>;
}

/** Everything the deploy does to the machine, so a test can watch it. */
export interface DeployEffects {
  /** The service report's snapshot of the live service managers, as it prints it. */
  snapshot(): string;
  /** The service report's compare of two snapshots. */
  compare(before: string, after: string): { unchanged: boolean; report: string };
  /** Compose up, waiting for health. */
  up(): void;
  /** The local image id a pinned reference resolves to, or undefined when it is not there. */
  imageId(ref: string): string | undefined;
  /** Each staging container's name and the image id it runs. */
  runningImages(): Record<string, string>;
}

export interface DeployRecord {
  action: 'deploy recorded';
  version: string;
  artefact: string;
}

export type DeployOutcome =
  { kind: 'refused' | 'failed'; reason: string } | { kind: 'deployed'; record: DeployRecord };

const definition = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
) as StagingDefinition;
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

/** The preflight on the database `DATABASE_ADMIN_URL` names: its signs, or why it could not judge. */
export async function stagingSigns(): Promise<string[]> {
  const url = process.env['DATABASE_ADMIN_URL'] ?? '';
  if (url === '') return ['DATABASE_ADMIN_URL is not set, so the preflight could not run'];
  const admin = connectAsAdmin(url, { source: 'preflight' });
  try {
    return await productionSigns(admin);
  } finally {
    await admin.close();
  }
}

/** Each staging container not on the image it was named by. */
function imageProblems(effects: DeployEffects): string[] {
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
  preflight: () => Promise<string[]> = stagingSigns,
): Promise<DeployOutcome> {
  const selected = storedArtefact(request.version, request.store);
  if (typeof selected === 'string') return { kind: 'refused', reason: selected };
  const pins = imagePinProblems(definition, pinRecord);
  if (pins.length > 0) {
    return {
      kind: 'refused',
      reason: `staging's images are not all pinned: ${pins.join('; ')}. Nothing was deployed.`,
    };
  }

  const signs = await preflight();
  if (signs.length > 0) {
    return {
      kind: 'refused',
      reason: `staging's database failed the preflight: ${signs.join('; ')}. Nothing was started.`,
    };
  }

  const before = effects.snapshot();
  effects.up();

  const problems = imageProblems(effects);
  const compared = effects.compare(before, effects.snapshot());
  if (!compared.unchanged) problems.push(`a live service changed:\n${compared.report}`);
  if (problems.length > 0) {
    return {
      kind: 'failed',
      reason: `${problems.join('; ')}. Staging is up but this deploy is not recorded: stop it with docker compose down and look.`,
    };
  }
  return {
    kind: 'deployed',
    record: { action: 'deploy recorded', version: request.version, artefact: selected.name },
  };
}
