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
// The agent's reply in Ada's one conversation is written as the exchange
// keeps one, with no model (`click-through-chat.mjs`). No grant is written,
// and every name is made up.
//
// Idempotent by lookup, never by truncation: each item has a fixed title (the
// untitled task a fixed description), and an item already in its end state is
// left alone. One whose task is there without it is refused: reset to repair.

import { randomUUID } from 'node:crypto';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { askTheAgent, CHAT_TITLE, chatState } from './click-through-chat.mjs';
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
const CATEGORY = { open: 'unstarted', started: 'started', done: 'completed' };

/** The untitled task is found by its description, since it has no title. */
const UNTITLED_NOTE = 'Click-through: a task saved with no title.';

/** A refusal this seed names, as against a fault it did not expect. */
export class Refusal extends Error {}

// A task's own record type: a comment's body sits in the same column as a title.
const TASKS = `select r.id from public.records r
    join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
   where r.business_id = $1 and t.key = 'task' and r.deleted_at is null`;

// Each item's end state, asked of its task ($1) in the business ($2).
const RUN = `from public.planned_runs run where run.business_id = $2 and run.task_id = $1`;
const PLAIN_END = `select from public.records r
    join public.records s on s.business_id = r.business_id and s.id = r.uuid_1
    left join public.clients c on c.business_id = r.business_id and c.id = r.uuid_7
   where r.business_id = $2 and r.id = $1 and s.txt_2 = $3 and c.name is not distinct from $4`;
const WAITING = `select ${RUN} and exists (select from public.gates g
    join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
   where g.business_id = $2 and g.run_id = run.id and g.state = 'pending' and v.version = 2)`;
const ENDED = {
  finished: `select ${RUN} and run.state = 'handed_back' and exists (select from
    public.handback_reports h where h.business_id = $2 and h.run_id = run.id
      and h.outcome = 'completed')`,
  capped: `select ${RUN} and run.state = 'waiting_budget'`,
  unknown: `select ${RUN} and exists (select from public.attempts a where a.business_id = $2
    and a.run_id = run.id and a.state = 'liability_unknown')`,
  helper: `select ${RUN} and exists (select from public.leases l
    join public.delegations child on child.business_id = l.business_id
      and child.parent_delegation_id = l.delegation_id
   where l.business_id = $2 and l.run_id = run.id)`,
};

/** Every item: its task's title, the end state it is seeded to, and how. */
function items(w, lost) {
  const run = (title, ended, build) => ({
    title,
    ended: [ended],
    build: async () => {
      await build(await task(w, { title }, NORTH, ADMIN));
    },
  });
  return [
    ...PLAIN.map(([title, client, who, end]) => ({
      title,
      ended: [PLAIN_END, CATEGORY[end], client],
      build: () => plainTask(w, title, client, who, end),
    })),
    { title: null, ended: null, build: () => task(w, { description: UNTITLED_NOTE }, null, ADMIN) },
    run('Demonstration task: draft the client update', WAITING, (id) => reviewWaiting(w, id)),
    run('Revise the brochure copy', WAITING, (id) => reviewWaiting(w, id)),
    run('Summarise the meeting notes', ENDED.finished, (id) => finished(w, id)),
    run('Research venue options', ENDED.capped, (id) => stopAtCap(w, id)),
    run('Post the event reminder', ENDED.unknown, async (id) => lost.push(await dispatched(w, id))),
    run('Reply to the supplier', ENDED.unknown, async (id) => lost.push(await dispatched(w, id))),
    run('Collect quotes for printing', ENDED.helper, (id) => handToHelper(w, id)),
    { title: CHAT_TITLE, state: () => chatState(w), build: () => askTheAgent(w) },
  ];
}

/**
 * Seed every item that is not there yet; the titles of those it made. An
 * item whose task is there without its end state was left halfway, and the
 * whole run is refused before its first write: a reset is the repair.
 */
export async function seedClickThrough(database, cast) {
  const w = world(database, cast);
  const lost = [];
  const wanted = [];
  for (const item of items(w, lost)) {
    // Read in turn, before anything is written.
    // oxlint-disable-next-line no-await-in-loop
    const state = await stateOf(w, item);
    if (state === 'stranded') {
      throw new Refusal(
        `'${item.title}' is there without its end state: reset staging and seed again.`,
      );
    }
    if (state === 'absent') wanted.push(item);
  }
  if (wanted.length === 0) return [];
  w.clients = await ensureClients(w);
  try {
    // In order, so the board reads in the order written here, each built on
    // the one before's committed state.
    // oxlint-disable-next-line no-await-in-loop
    for (const item of wanted) await item.build();
  } finally {
    // A dispatched run's lease runs out whether or not a later item failed.
    if (lost.length > 0) await sweepLost(w, lost);
  }
  return wanted.map((item) => item.title ?? '(untitled)');
}

async function stateOf(w, item) {
  if (item.state !== undefined) return await item.state();
  const id =
    item.title === null
      ? (
          await w.query(`${TASKS} and r.txt_4 is null and r.data ->> 'description' = $2`, [
            w.cast.businessId,
            UNTITLED_NOTE,
          ])
        )[0]?.id
      : await w.taskTitled(item.title);
  if (id === undefined) return 'absent';
  if (item.ended === null) return 'ended';
  const [sql, ...rest] = item.ended;
  const [row] = await w.query(`select exists (${sql}) as ended`, [id, w.cast.businessId, ...rest]);
  return row.ended ? 'ended' : 'stranded';
}

/** A plain task, taken to its state by the person who made it. */
async function plainTask(w, title, client, who, end) {
  const id = await task(w, { title }, client, who);
  if (ENDS[end] !== undefined) {
    await w.as(who, { command: ENDS[end], recordId: id, expectedRevision: await w.revision(id) });
  }
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
    asAgent: (credential, body) =>
      applied(
        executeAgentCommand(database, cast.businessId, cast.agent, credential, operation(body)),
      ),
    revision: async (id) =>
      Number(
        (
          await query('select revision from public.records where business_id = $1 and id = $2', [
            cast.businessId,
            id,
          ])
        )[0].revision,
      ),
    taskTitled: async (title) =>
      (await query(`${TASKS} and r.txt_4 = $2`, [cast.businessId, title]))[0]?.id,
    purposes: 0,
  };
}

/** The three made-up clients, each found by name or made by the admin. */
async function ensureClients(w) {
  const ids = new Map();
  for (const name of CLIENTS) {
    // Each is looked up before it is made, one at a time.
    // oxlint-disable-next-line no-await-in-loop
    const [held] = await w.query(
      'select id from public.clients where business_id = $1 and lower(name) = lower($2)',
      [w.cast.businessId, name],
    );
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
