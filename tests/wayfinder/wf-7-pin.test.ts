// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "skill pinned by digest", on the run start: a person pressing
// Run on a research ticket (`task.propose`) pins the vendored research skill
// on the run it plans, in the same transaction (ORCH47 ruling (b)8): one
// `run_definition_pins` row, SKILL.md, the folder's files in its manifest. A
// skill its lock does not pin refuses the start, with nothing written; the
// tampered case adds a byte to SKILL.md as the repository's folder serves it.
// On the real commands against Postgres. The pin helper (`pinResearchSkill`)
// is also here by hand, on a plain task's run no start has pinned.

import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it as vitestIt, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pinResearchSkill, RESEARCH_SKILL } from '../../packages/core-commands/src/index.ts';
import {
  admitActivation,
  captureManifest,
  directorySource,
  type InstructionSource,
} from '../../packages/core-runtime/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approveBody,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  openSchedules,
  pickup,
  propose,
  proposeBody,
  revisionOf,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { skillFolderHash } from './skill-digest.ts';

/** When set, the research skill's folder serves SKILL.md with one byte added. */
const tamper = vi.hoisted(() => ({ on: false }));

vi.mock('../../packages/core-runtime/src/instruction-root.ts', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../packages/core-runtime/src/instruction-root.ts')>();
  return {
    ...original,
    directorySource: (root: string): InstructionSource => {
      const real = original.directorySource(root);
      if (!root.split(sep).join('/').endsWith('.claude/skills/research')) return real;
      return {
        ...real,
        read: async (path) => {
          const bytes = await real.read(path);
          return tamper.on && path === 'SKILL.md' && bytes !== undefined
            ? new Uint8Array([...bytes, 0x0a])
            : bytes;
        },
      };
    },
  };
});

let s: Schedules;

const SKILL_FOLDER = join(import.meta.dirname, '../..', RESEARCH_SKILL.folder);

function filesUnder(at: string): readonly string[] {
  return readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(at, entry.name))
      : [relative(SKILL_FOLDER, join(at, entry.name)).split(sep).join('/')],
  );
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The folder, SKILL.md with a byte added on the reads `edited` names (its count from 1). */
const editedOn = (edited: (read: number) => boolean): InstructionSource => {
  let reads = 0;
  return {
    read: async (path) => {
      const bytes = await directorySource(SKILL_FOLDER).read(path);
      if (path !== RESEARCH_SKILL.entry || bytes === undefined) return bytes;
      reads += 1;
      return edited(reads) ? new Uint8Array([...bytes, 0x0a]) : bytes;
    },
  };
};

/** A second person, who may approve the decider's proposals and holds run:write business-wide. */
const approverOf = async (): Promise<Member> => {
  const approver = await enrol(s.db.app, s.business, `wf7pin-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, approver, action, undefined, true);
    }
    await grantTo(tx, approver, 'write', undefined, false, 'run');
  });
  return approver;
};

const researchTicket = async (title: string): Promise<string> => {
  const outcome = await asPerson(s, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
    taskType: 'research',
  });
  appliedDetail(outcome, 'task.create');
  const ticket = String((outcome as { recordId: string }).recordId);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'write', { kind: 'record', id: ticket }, false, 'run');
  });
  return ticket;
};

const start = async (ticket: string) =>
  await asPerson(s, proposeBody(ticket, await revisionOf(s, ticket), { purpose: freshPurpose() }));

const count = async (sql: string, ...params: readonly unknown[]): Promise<number> =>
  (await s.db.admin.execute<{ n: number }>(sql, [s.business, ...params]))[0]?.n ?? 0;

const runsOn = async (ticket: string): Promise<number> =>
  await count(
    'select count(*)::int as n from public.planned_runs where business_id = $1 and task_id = $2',
    ticket,
  );

const PINS = 'select count(*)::int as n from public.run_definition_pins where business_id = $1';
const pins = async (): Promise<number> => await count(PINS);

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

beforeAll(async () => {
  if (!noDatabase) s = await openSchedules('wf7pin', 1_000_000);
}, 180_000);
afterAll(async () => await s?.db.drop());
afterEach(() => {
  tamper.on = false;
});

it('WF-7 skill pinned by digest: a person starting a research run pins the research skill on the run, with its manifest', async () => {
  // The lock is the upstream one, and the vendored folder has its digest.
  const lock = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../skills-lock.json'), 'utf8'),
  ) as { skills: Record<string, { computedHash: string }> };
  expect(RESEARCH_SKILL.digest).toBe(lock.skills['research']?.computedHash);
  expect(skillFolderHash(SKILL_FOLDER)).toBe(RESEARCH_SKILL.digest);
  const ticket = await researchTicket('wf7 pin on start');
  const started = appliedDetail(await start(ticket), 'task.propose');
  const rows = await s.db.admin.execute<Record<string, unknown>>(
    `select ref_kind, path, content_digest, content_size::int as content_size, manifest,
            manifest_digest, pinned_by_actor_id
       from public.run_definition_pins where business_id = $1 and run_id = $2`,
    [s.business, started['runId']],
  );
  const files = filesUnder(SKILL_FOLDER);
  const expected = await captureManifest(directorySource(SKILL_FOLDER), files);
  if (!expected.ok) throw new Error('the vendored skill reads');
  const entry = readFileSync(join(SKILL_FOLDER, RESEARCH_SKILL.entry));
  expect(rows).toEqual([
    {
      ref_kind: 'bootstrap_file',
      path: 'SKILL.md',
      content_digest: sha256(entry),
      content_size: entry.byteLength,
      manifest: files
        .map((path) => {
          const bytes = readFileSync(join(SKILL_FOLDER, path));
          return { path, digest: sha256(bytes), size: bytes.byteLength };
        })
        .toSorted((a, b) => (a.path < b.path ? -1 : 1)),
      manifest_digest: expected.value.digest,
      pinned_by_actor_id: s.decider.actorId,
    },
  ]);
}, 60_000);

it('WF-7 skill pinned by digest: a tampered skill refuses the start, and nothing is written', async () => {
  const ticket = await researchTicket('wf7 pin tampered');
  const revision = await revisionOf(s, ticket);
  const pinsBefore = await pins();
  tamper.on = true;
  expect(codeOf(await start(ticket))).toBe('DEFINITION_DIGEST_MISMATCH');
  expect(await runsOn(ticket)).toBe(0);
  expect(await pins()).toBe(pinsBefore);
  const lineages = 'select count(*)::int as n from public.proposal_lineages where business_id = $1';
  expect(await count(`${lineages} and task_id = $2`, ticket)).toBe(0);
  expect(await revisionOf(s, ticket)).toBe(revision);
  // The untouched skill starts the same ticket.
  tamper.on = false;
  appliedDetail(await start(ticket), 'task.propose');
  expect(await runsOn(ticket)).toBe(1);
  expect(await pins()).toBe(pinsBefore + 1);
}, 60_000);

it("WF-7 skill pinned by digest: an agent's research start is refused and pins nothing", async () => {
  // Stage 1 (ORCH49-R2): only a person starts a research run; an agent's
  // start activating the skill is a later-stage line. Every other check
  // passes here: the agent's person (the approver) holds run:write
  // business-wide at the pickup, so the delegation reaches run, and the
  // ticket, picked up as a plain task and turned research after, is
  // unclaimed. What refuses is the activation (wf-7-run has the delegation's
  // reach refusing).
  const approver = await approverOf();
  const task = await createTask(s, 'wf7 pin agent start');
  const purpose = freshPurpose();
  const proposal = await propose(s, task, { purpose });
  const decision = appliedDetail(
    await executeCommand(
      s.db.app,
      s.business,
      approver.presented,
      'api',
      approveBody(proposal) as never,
    ),
    'task.decide',
  );
  const picked = await pickup(s, decision['reservationId']);
  appliedDetail(
    await asPerson(s, {
      command: 'task.set_type',
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: await revisionOf(s, task),
      taskType: 'research',
    }),
    'task.set_type',
  );
  const runs = await runsOn(task);
  const pinsBefore = await pins();
  const revision = await revisionOf(s, task);
  const answer = await asAgent(
    s,
    // In the run's own lineage, so the envelope's room is the superseded version's.
    proposeBody(task, revision, { purpose, lineageId: String(proposal['lineageId']) }),
    String(picked['credential']),
  );
  expect(codeOf(answer)).toBe('DELEGATION_EXCLUDES_ACTIVATION');
  expect(await runsOn(task)).toBe(runs);
  expect(await pins()).toBe(pinsBefore);
  expect(await revisionOf(s, task)).toBe(revision);
}, 60_000);

/** A run with no pin yet, for the pin helper by hand: a plain task's (a run holds one pin). */
const unpinnedRun = async (title: string): Promise<string> =>
  String((await propose(s, await createTask(s, title), { purpose: freshPurpose() }))['runId']);

const pinsOn = async (runId: string): Promise<number> =>
  await count(`${PINS} and run_id = $2`, runId);

/** The skill pinned by hand on the run's record, by the person who proposed it, from `source`. */
const pinOn = async (runId: string, source: InstructionSource) => {
  const admitted = admitActivation({
    mode: 'manual',
    activator: { kind: 'person', actorId: s.decider.actorId },
  });
  if (!admitted.ok) throw new Error('the starter is a person, by hand');
  const files = filesUnder(SKILL_FOLDER);
  return await s.db.app.withBusiness(s.business, (tx) =>
    pinResearchSkill(tx, admitted.value, { runId, source, files }),
  );
};

it('WF-7 research skill digest: the pin helper refuses one byte changed as another skill, and pins nothing', async () => {
  const runId = await unpinnedRun('and a changed skill?');
  expect(
    await pinOn(
      runId,
      editedOn(() => true),
    ),
  ).toMatchObject({
    ok: false,
    refusal: { code: 'DEFINITION_DIGEST_MISMATCH' },
  });
  expect(await pinsOn(runId)).toBe(0);
});

it('WF-7 research skill digest: the bytes pinned are the bytes checked', async () => {
  const runId = await unpinnedRun('which bytes were pinned?');
  // The entry's first read is an edited file and every later read the upstream one.
  expect(
    await pinOn(
      runId,
      editedOn((read) => read === 1),
    ),
  ).toMatchObject({
    ok: false,
    refusal: { code: 'DEFINITION_DIGEST_MISMATCH' },
  });
  expect(await pinsOn(runId)).toBe(0);
});
