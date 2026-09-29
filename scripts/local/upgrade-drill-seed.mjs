// SPDX-License-Identifier: AGPL-3.0-only
//
// The upgrade drill's seed (scripts/local/upgrade-drill.mjs): one business
// with a person who may sign in, enrolled as the application, and tasks
// written through the product's own commands, so the older schema holds rows
// the head's upgrade must keep.

import { randomUUID } from 'node:crypto';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';

/** A failure whose message the drill wrote itself, so it carries no record data. */
export class Failure extends Error {}

/** A business and one person who may sign in and work its tasks, written as the application. */
async function enrolBusiness(app, key) {
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
async function seedTasks(app, key, { business, presented }) {
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

/** Two businesses, so the snapshot holds more than one tenant's rows. */
export async function seed(app) {
  await seedTasks(app, 'drill-alpha', await enrolBusiness(app, 'drill-alpha'));
  await seedTasks(app, 'drill-bravo', await enrolBusiness(app, 'drill-bravo'));
}
