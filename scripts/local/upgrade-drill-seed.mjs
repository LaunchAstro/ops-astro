// SPDX-License-Identifier: AGPL-3.0-only
//
// The upgrade drill's seed (scripts/local/upgrade-drill.mjs): one business
// with a person who may sign in, enrolled as the application, and tasks
// written through the product's own commands, so the older schema holds rows
// the head's upgrade must keep. The commands are the older version's own, read
// from its checkout: the head's may need tables the older schema has not got.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A failure whose message the drill wrote itself, so it carries no record data. */
export class Failure extends Error {}

const root = fileURLToPath(new URL('../..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/**
 * The commit to seed at, or why there is none: `base` when CI names it,
 * otherwise the commit that added `start`, the version as it first shipped.
 * Its newest migration must be `start`, or the seed would run another
 * version's commands.
 */
export function baseCommit(start, base) {
  if (base !== undefined && !/^[0-9a-f]{7,64}$/u.test(base))
    return { refused: '--base must be a commit id' };
  const candidates =
    base === undefined
      ? git('log', '--diff-filter=A', '--format=%H', 'HEAD', '--', `migrations/${start}.sql`)
      : base;
  const newestAt = (commit) =>
    git('ls-tree', '--name-only', commit, 'migrations/')
      .split('\n')
      .filter((f) => f.endsWith('.sql'))
      .toSorted()
      .at(-1);
  const commit = candidates
    .split('\n')
    .find((c) => c !== '' && newestAt(c) === `migrations/${start}.sql`);
  if (commit === undefined) {
    const which = base === undefined ? 'no commit here has' : `${base} does not have`;
    return { refused: `${which} ${start} as its newest migration; name one with --base` };
  }
  return { commit: git('rev-parse', '--verify', `${commit}^{commit}`) };
}

/** That commit's files in a temporary folder, with this checkout's installed packages. */
function checkout(commit) {
  const directory = mkdtempSync(join(tmpdir(), 'upgrade-drill-base-'));
  try {
    const archive = execFileSync('git', ['archive', commit], { cwd: root, maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', directory], { input: archive });
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'));
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return directory;
}

/** The product functions the seed calls, imported from the checkout at `tree`. */
async function productAt(tree) {
  const load = async (path) => await import(pathToFileURL(join(tree, 'packages', path)).href);
  // The command layer moved out of core-records into its own package on 28 Sep (139429f).
  const commands = existsSync(join(tree, 'packages/core-commands/src/index.ts'))
    ? await load('core-commands/src/index.ts')
    : {
        ...(await load('core-records/src/commands/envelope.ts')),
        ...(await load('core-records/src/commands/refusal.ts')),
      };
  return {
    executeCommand: commands.executeCommand,
    isCommandRefusal: commands.isCommandRefusal,
    issueGrant: (await load('core-records/src/authority/grants.ts')).issueGrant,
    installTaskSpine: (await load('core-records/src/tasks/install.ts')).installTaskSpine,
  };
}

/** A business and one person who may sign in and work its tasks, written as the application. */
// eslint-disable-next-line max-lines-per-function -- one business, enrolled in one place
async function enrolBusiness(app, key, { issueGrant, installTaskSpine }) {
  const [business, person, actor, login] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const subject = `${key}-${randomUUID()}`;
  await app.withBusiness(business, async (tx) => {
    const rows = [
      ['insert into businesses (business_id, id, key, name) values ($1, $1, $2, $2)', [key]],
      ['insert into people (business_id, id, display_name) values ($1, $2, $3)', [person, key]],
      [
        `insert into actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)`,
        [actor, person],
      ],
      [
        `insert into memberships (business_id, id, person_id, role_key) values ($1, $2, $3, 'member')`,
        [randomUUID(), person],
      ],
      [
        `insert into budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'local', 500000, 'AUD')`,
        [randomUUID()],
      ],
      [
        `insert into logins (business_id, id, provider, subject) values ($1, $2, 'supabase', $3)`,
        [login, subject],
      ],
      [
        `insert into person_logins (business_id, id, login_id, person_id, active, linked_by_actor_id)
         values ($1, $2, $3, $4, true, $5)`,
        [randomUUID(), login, person, actor],
      ],
    ];
    for (const [sql, values] of rows) {
      // oxlint-disable-next-line no-await-in-loop
      await tx.query(sql, [business, ...values]);
    }
    await installTaskSpine(tx);
    for (const action of ['read', 'write', 'comment', 'assign', 'decide']) {
      // oxlint-disable-next-line no-await-in-loop
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: person },
        scope: { kind: 'business', id: null },
        collection: 'task',
        action,
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: actor,
      });
      if (!issued.ok)
        throw new Failure(`the seed's ${action} grant was refused: ${issued.refusal.code}`);
    }
  });
  return { business, presented: { provider: 'supabase', subject } };
}

/** Tasks with a history: created, renamed, started, commented, completed and reopened. */
async function seedTasks(app, key, { business, presented }, { executeCommand, isCommandRefusal }) {
  const revisionOf = async (id) =>
    await app.withBusiness(business, async (tx) => {
      const [row] = await tx.query('select revision::int as revision from records where id = $1', [
        id,
      ]);
      return row?.revision;
    });
  const run = async (request) => {
    const target = request.recordId;
    const outcome = await executeCommand(app, business, presented, 'api', {
      operationId: randomUUID(),
      ...(target === undefined ? {} : { expectedRevision: await revisionOf(target) }),
      ...request,
    });
    if (isCommandRefusal(outcome)) {
      throw new Failure(`the seed's ${request.command} was refused: ${outcome.code}`);
    }
    return outcome;
  };
  const created = async (title) =>
    (await run({ command: 'task.create', fields: { title: `${key} ${title}` } })).recordId;
  const first = await created('first task');
  const second = await created('second task');
  const third = await created('third task');
  await run({
    command: 'task.update',
    recordId: first,
    fields: { title: `${key} first, renamed` },
  });
  await run({ command: 'task.start', recordId: first });
  const note = { body: 'a seeded note', audience: 'internal' };
  await run({ command: 'task.comment', recordId: second, ...note });
  await run({ command: 'task.complete', recordId: second });
  await run({ command: 'task.reopen', recordId: second, reason: 'seeded reopen' });
  // A gate decision, so decisions and their history are compared too.
  const { detail } = await run({
    command: 'task.propose',
    recordId: third,
    purpose: 'draft_the_reply',
    maximumMinor: 1000,
    currency: 'AUD',
    payload: { instruction: 'a seeded proposal' },
    step: { kind: 'compose', payload: { tone: 'plain' } },
  });
  const { gateId, versionId } = detail;
  const decision = { decision: 'approve', note: 'a seeded approval' };
  await run({ command: 'task.decide', gateId, versionId, ...decision });
}

/** Two businesses, so the snapshot holds more than one tenant's rows, through `commit`'s commands. */
export async function seed(app, commit) {
  const older = checkout(commit);
  try {
    const product = await productAt(older);
    for (const key of ['drill-alpha', 'drill-bravo']) {
      // oxlint-disable-next-line no-await-in-loop -- one business after the other
      await seedTasks(app, key, await enrolBusiness(app, key, product), product);
    }
  } finally {
    rmSync(older, { recursive: true, force: true });
  }
}
