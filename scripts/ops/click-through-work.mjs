// SPDX-License-Identifier: AGPL-3.0-only
//
// What the click-through seed makes, and how (SR-1). `click-through-seed.mjs`
// admits the database and finds the cast; this file only writes.
//
// Every item is made as the cast's own person or seeded agent through the
// product's command entries (`executeCommand`, `executeAgentCommand`), so the
// history, audit and receipts rows are the product's own. Two steps have no
// command: the stop at the cap is the broker's `raiseBudgetWait`, called as
// its `stopAtCeiling` calls it, and the unknown outcome is the lease sweep's
// (`sweepExpiredLeases`) after a dispatched run's lease runs out. The helper
// agent is an actor and a login, inserted as local-seed inserts the agent.
// No grant is written, and every name is made up.
//
// Idempotent by lookup, never by truncation: each item has a fixed title (the
// untitled task a fixed description), and an item whose task is there is left
// alone. An item that failed halfway is left as it stands, not repaired.

import { randomUUID } from 'node:crypto';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  dispatched,
  finished,
  handToHelper,
  reviewWaiting,
  stopAtCap,
  sweepLost,
} from './click-through-runs.mjs';

/** The cast's first business, and who works in it. */
export const BUSINESS = 'alpha';
export const ADMIN = 'Ada Alpha';
export const MEMBER = 'Mia Alpha';

const CLIENTS = ['Example Client North', 'Example Client South', 'Example Client East'];
const [NORTH, SOUTH, EAST] = CLIENTS;

/** Ten plain tasks: title, client (or none), who makes it, and where it ends. */
const PLAIN = [
  ['Draft the spring newsletter', NORTH, ADMIN, 'open'],
  ['Update opening hours on the website', NORTH, ADMIN, 'started'],
  ['Send the welcome pack', NORTH, ADMIN, 'done'],
  ['Plan the client workshop', SOUTH, ADMIN, 'open'],
  ['Order new business cards', SOUTH, ADMIN, 'done'],
  ['Check last month invoices', EAST, ADMIN, 'started'],
  ['Write three social posts', EAST, ADMIN, 'done'],
  ['Review the logo options', EAST, ADMIN, 'open'],
  ['Book the team photo shoot', null, MEMBER, 'open'],
  ['Tidy the shared drive', null, MEMBER, 'started'],
];
const ENDS = { started: 'task.start', done: 'task.complete' };

/** The untitled task is found by its description, since it has no title. */
const UNTITLED_NOTE = 'Click-through: a task saved with no title.';

/** The tasks that carry a run. */
const RUNS = {
  demonstration: 'Demonstration task: draft the client update',
  revised: 'Revise the brochure copy',
  finished: 'Summarise the meeting notes',
  capped: 'Research venue options',
  unknownOne: 'Post the event reminder',
  unknownTwo: 'Reply to the supplier',
  helper: 'Collect quotes for printing',
};

// A task's own record type: a comment's body sits in the same column as a title.
const TASKS = `select r.id from public.records r
    join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
   where t.key = 'task' and r.deleted_at is null`;

/** Seed every item that is not there yet; the titles of those it made. */
export async function seedClickThrough(database, cast) {
  const w = world(database, cast);
  w.clients = await ensureClients(w);
  return [...(await seedPlain(w)), ...(await seedRuns(w))];
}

/** The ten plain tasks, each in its state, and the untitled one. */
async function seedPlain(w) {
  const made = [];
  for (const [title, client, who, end] of PLAIN) {
    // In order, so the board reads in the order written here.
    // oxlint-disable-next-line no-await-in-loop
    if ((await w.taskTitled(title)) !== undefined) continue;
    // oxlint-disable-next-line no-await-in-loop
    const id = await task(w, { title }, client, who);
    if (ENDS[end] !== undefined) {
      // oxlint-disable-next-line no-await-in-loop
      await w.as(who, { command: ENDS[end], recordId: id, expectedRevision: await w.revision(id) });
    }
    made.push(title);
  }
  const untitled = `${TASKS} and r.txt_4 is null and r.data ->> 'description' = $1`;
  if ((await w.query(untitled, [UNTITLED_NOTE])).length === 0) {
    await task(w, { description: UNTITLED_NOTE }, null, ADMIN);
    made.push('(untitled)');
  }
  return made;
}

/** The tasks that carry a run, each on the made-up client North. */
async function seedRuns(w) {
  const made = [];
  const lost = [];
  const steps = [
    ['demonstration', (id) => reviewWaiting(w, id)],
    ['revised', (id) => reviewWaiting(w, id)],
    ['finished', (id) => finished(w, id)],
    ['capped', (id) => stopAtCap(w, id)],
    ['unknownOne', async (id) => lost.push(await dispatched(w, id))],
    ['unknownTwo', async (id) => lost.push(await dispatched(w, id))],
    ['helper', (id) => handToHelper(w, id)],
  ];
  for (const [key, build] of steps) {
    // Each run is built on the one before's committed state.
    // oxlint-disable-next-line no-await-in-loop
    if ((await w.taskTitled(RUNS[key])) !== undefined) continue;
    // oxlint-disable-next-line no-await-in-loop
    await build(await task(w, { title: RUNS[key] }, NORTH, ADMIN));
    made.push(RUNS[key]);
  }
  if (lost.length > 0) await sweepLost(w);
  return made;
}

/** The calls every item makes, as the cast. */
function world(database, cast) {
  const query = (text, parameters) =>
    database.withBusiness(cast.businessId, (tx) => tx.query(text, parameters));
  return {
    admin: ADMIN,
    cast,
    database,
    query,
    as: (name, body) =>
      applied(executeCommand(database, cast.businessId, cast.people[name], 'api', operation(body))),
    asAgent: (credential, body, agent = cast.agent) =>
      applied(executeAgentCommand(database, cast.businessId, agent, credential, operation(body))),
    revision: async (id) =>
      Number((await query('select revision from public.records where id = $1', [id]))[0].revision),
    taskTitled: async (title) => (await query(`${TASKS} and r.txt_4 = $1`, [title]))[0]?.id,
    purposes: 0,
  };
}

/** The three made-up clients, each found by name or made by the admin. */
async function ensureClients(w) {
  const ids = new Map();
  for (const name of CLIENTS) {
    // Each is looked up before it is made, one at a time.
    // oxlint-disable-next-line no-await-in-loop
    const [held] = await w.query('select id from public.clients where lower(name) = lower($1)', [
      name,
    ]);
    // oxlint-disable-next-line no-await-in-loop
    ids.set(name, held?.id ?? (await w.as(ADMIN, { command: 'client.create', name })).clientId);
  }
  return ids;
}

/** A task, its client set straight away: a client locks once the task has content. */
async function task(w, fields, client, who) {
  const made = await w.as(who, { command: 'task.create', fields });
  if (client !== null) {
    await w.as(ADMIN, {
      command: 'task.set_party',
      recordId: made.recordId,
      expectedRevision: made.revision,
      fields: { client: w.clients.get(client) },
    });
  }
  return made.recordId;
}

/** A body with an operation id of its own. */
function operation(body) {
  return { operationId: `click-through:${randomUUID()}`, ...body };
}

/** The applied result's detail with its record and revision, or a throw naming the refusal. */
async function applied(pending) {
  const result = await pending;
  if (isCommandRefusal(result)) {
    throw new Error(`click-through-seed: refused ${result.code} ${JSON.stringify(result)}`);
  }
  return { ...result.detail, recordId: result.recordId, revision: result.revision };
}
