// SPDX-License-Identifier: AGPL-3.0-only
//
// What the #1904 definition proofs share, on the door world
// (`run-stop-door-world.ts`) and the turn broker (`turn-world.ts`): an
// instruction folder the API reads from (`OPS_ASTRO_INSTRUCTION_ROOT`), a run
// picked up and pinned by a person's manual activation with a manifest of
// named files (as MP-6-2 pins, `pinBootstrapFile`), `definition.read` through
// the real agent door, and the definition part a worker sends from its
// answer. The rows a case asserts on are read by the admin connection.
//
// Every file's bytes carry a fresh uuid, so its digest is in no other row:
// a case asserting "no copy" names a file no earlier case read.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import type { ModelBroker } from '../../packages/core-commands/src/index.ts';
import { REPLAY_PATH } from '../../packages/core-connectors/src/index.ts';
import {
  admitActivation,
  captureManifest,
  pinBootstrapFile,
} from '../../packages/core-runtime/src/index.ts';
import type { Answer } from '../api/fixture.ts';
import { sourceOf } from '../runtime/aw-02-world.ts';
import { liveWork, rows, scalar, type Schedules, type Work } from '../runtime/schedules-harness.ts';
import {
  asAgent,
  leaseOf,
  noDatabase,
  s,
  useDoorWorld,
  world,
  type SignedIn,
} from './run-stop-door-world.ts';
import { detailOf, turnBroker } from './turn-world.ts';

export const ROOT_VARIABLE = 'OPS_ASTRO_INSTRUCTION_ROOT';

/** The run's entry file, at the folder's root. */
export const ENTRY = 'AGENTS.md';

const files = new Map<string, Uint8Array>();
let root = '';

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Write `bytes` at `path` in the instruction folder, and keep them for the manifest. */
export function plant(path: string, bytes: Uint8Array): string {
  const at = join(root, path);
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, bytes);
  files.set(path, bytes);
  return path;
}

/** A file of its own at a fresh path: `text`, then a uuid line, unless `bytes` are given whole. */
export function freshFile(text = '# A skill\nRead the task.\n', bytes?: Uint8Array): string {
  return plant(`skills/${randomUUID()}/SKILL.md`, bytes ?? encode(`${text}${randomUUID()}\n`));
}

export function bytesOf(path: string): Uint8Array {
  const bytes = files.get(path);
  if (bytes === undefined) throw new Error(`no planted file at ${path}`);
  return bytes;
}

export const digestOf = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** The file as `definition.read` answers it: UTF-8, a BOM kept. */
export const textOf = (path: string): string =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytesOf(path));

/**
 * The door world, with the instruction folder made and named before the API
 * starts, and the entry file planted in it. The folder goes with the file.
 */
export function useDefinitionWorld(
  label: string,
  broker: () => ModelBroker = turnBroker(10),
): void {
  beforeAll(() => {
    if (noDatabase) return;
    root = mkdtempSync(join(tmpdir(), 'instructions-'));
    process.env[ROOT_VARIABLE] = root;
    plant(ENTRY, encode(`# Agents\nDraft the reply in plain words.\n${randomUUID()}\n`));
  });
  useDoorWorld(label, broker);
  afterAll(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true });
    delete process.env[ROOT_VARIABLE];
  });
}

/** Live work, its run pinned with `paths` in the manifest and the entry first. */
export interface Pinned {
  readonly work: Work;
  readonly runId: string;
  readonly stepId: string;
}

export async function runOf(work: Work, of: Schedules = s): Promise<Omit<Pinned, 'work'>> {
  const [row] = await rows<{ run_id: string; step_id: string }>(
    of,
    `select l.run_id, a.step_id from public.leases l
       join public.attempts a on a.business_id = l.business_id and a.lease_id = l.id
      where l.business_id = $1 and l.id = $2`,
    [of.business, leaseOf(work)],
  );
  if (row === undefined) throw new Error('setup: the work has no attempt');
  return { runId: row.run_id, stepId: row.step_id };
}

/** A person's manual activation pins the run's entry, with every one of `paths` in the manifest. */
export async function pin(
  work: Work,
  paths: readonly string[] = [ENTRY],
  of: Schedules = s,
): Promise<Pinned> {
  const run = await runOf(work, of);
  const activation = admitActivation({
    mode: 'manual',
    activator: { kind: 'person', actorId: of.decider.actorId },
  });
  if (!activation.ok) throw new Error('setup: activation refused');
  const manifest = await captureManifest(sourceOf(files), [ENTRY, ...paths]);
  if (!manifest.ok) throw new Error('setup: manifest refused');
  await of.db.app.withBusiness(of.business, async (tx) => {
    const pinned = await pinBootstrapFile(tx, activation.value, {
      runId: run.runId,
      entryPath: ENTRY,
      manifest: manifest.value,
    });
    if (!pinned.ok) throw new Error('setup: pin refused');
  });
  return { work, ...run };
}

export async function pinnedWork(
  title: string,
  paths: readonly string[] = [ENTRY],
  of: Schedules = s,
): Promise<Pinned> {
  return await pin(await liveWork(of, title, 2_000), paths, of);
}

/** `definition.read`'s body: exactly its four operands and the operation id. */
export const readBody = (
  on: Pinned,
  path: string = ENTRY,
  over: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> & { readonly operationId: string } => ({
  operationId: randomUUID(),
  leaseId: leaseOf(on.work),
  fence: on.work.picked['fence'],
  stepId: on.stepId,
  path,
  ...over,
});

export async function read(
  on: Pinned,
  body: Readonly<Record<string, unknown>>,
  as: SignedIn,
  key?: string,
): Promise<Answer> {
  return await asAgent('/definition/read', on.work, body, as, key);
}

/** A read that must answer the file: its detail. */
export async function readOk(
  on: Pinned,
  as: SignedIn,
  path: string = ENTRY,
  key?: string,
): Promise<Readonly<Record<string, unknown>>> {
  const answer = await read(on, readBody(on, path), as, key);
  const detail = detailOf(answer);
  if (typeof detail['text'] !== 'string') {
    throw new TypeError(`setup: definition.read did not answer: ${JSON.stringify(answer.body)}`);
  }
  return detail;
}

/** The definition part a worker sends, as `definition.read` answered the file. */
export const definitionPart = (
  path: string,
  over: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  ref: 'definition',
  path,
  digest: digestOf(bytesOf(path)),
  text: textOf(path),
  ...over,
});

/** A refusal carries no file text: no `text` in its detail, and the words nowhere in its body. */
export function carriesNoText(answer: Answer, path: string = ENTRY): void {
  expect(detailOf(answer)).not.toHaveProperty('text');
  expect(JSON.stringify(answer.body)).not.toContain(JSON.stringify(textOf(path)).slice(1, -1));
}

/** The run's ledger rows. */
export const ledgerOf = async (runId: string, of: Schedules = s): Promise<number> =>
  await scalar(
    of,
    'select count(*)::text as n from public.bootstrap_reads where business_id = $1 and run_id = $2',
    [of.business, runId],
  );

/** The business's kept copies of one file. */
export const copiesOf = async (path: string, of: Schedules = s): Promise<number> =>
  await scalar(
    of,
    `select count(*)::text as n from public.bootstrap_bytes
      where business_id = $1 and content_digest = $2`,
    [of.business, digestOf(bytesOf(path))],
  );

/** The audit events one operation id wrote. */
export const eventsOf = async (operationId: string, of: Schedules = s): Promise<number> =>
  await scalar(
    of,
    'select count(*)::text as n from public.audit_events where business_id = $1 and operation_id = $2',
    [of.business, operationId],
  );

/** Nothing the read would write: no ledger row on the run, no copy of the file, no event. */
export async function wroteNothing(on: Pinned, path: string, operationId: string): Promise<void> {
  expect(await ledgerOf(on.runId), 'no ledger row').toBe(0);
  expect(await copiesOf(path), 'no kept copy').toBe(0);
  expect(await eventsOf(operationId), 'no audit event').toBe(0);
}

/** The lease's expiry, on the database clock, `seconds` from now. Its delegation is untouched. */
export async function leaseEndsIn(work: Work, seconds: number): Promise<void> {
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() + make_interval(secs => $3)
      where business_id = $1 and id = $2`,
    [s.business, leaseOf(work), seconds],
  );
}

export const LEASE_EXPIRY = 'select expires_at from public.leases where id = $1';

/** The messages of each turn the provider was sent after `mark`, as the broker made them. */
export function sentSince(mark: number): readonly (readonly Record<string, unknown>[])[] {
  return world.provider.seen
    .slice(mark)
    .filter((seen) => seen.path === REPLAY_PATH)
    .map((seen) => {
      const body = JSON.parse(seen.body) as { fields: { turn: string } };
      return JSON.parse(body.fields.turn) as Record<string, unknown>[];
    });
}

/** The routes a lease's calls took, in order. */
export const routesOf = async (work: Work): Promise<readonly string[]> =>
  (
    await rows<{ route_reach: string }>(
      s,
      `select route_reach from public.model_calls where business_id = $1 and lease_id = $2
        order by accepted_at`,
      [s.business, leaseOf(work)],
    )
  ).map((row) => row.route_reach);
