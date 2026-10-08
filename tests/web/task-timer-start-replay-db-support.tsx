// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { grantTo } from '../commands/fixture.ts';
import { WHOLE, type TimeWorld } from '../commands/time-world.ts';
import { draftReply, type Sent } from './projects-draft-app-support.tsx';
import { realm } from './task-timer-recovery-support.tsx';

export const TIMER = 'ops-astro.task-timer';
export const STRIP = '[data-task-timer-strip]';
export const PAGE = 'main [data-time-log-section] [data-timer]';
export const RETRY = '[data-task-timer-retry]';
export const TITLE = 'Private timer recovery canary';
export type AppRealm = Awaited<ReturnType<typeof realm>>;

const noReply = (): void => {};
export function gate() {
  let release = noReply;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}
export async function revokeTime(w: TimeWorld): Promise<void> {
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    const ids = await tx.query<{ readonly id: string }>(
      `select id from public.grants where subject_kind = 'person' and subject_id = $1
         and collection = 'time' and action = 'write' and revoked_at is null`,
      [w.clientA.personId],
    );
    await Promise.all(ids.map(async (row) => await revokeGrant(tx, row.id)));
  });
}
export async function restoreTime(w: TimeWorld): Promise<void> {
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.clientA, 'write', WHOLE, false, 'time');
  });
}
export async function live(w: TimeWorld, entryId: string): Promise<boolean> {
  const rows = await w.db.admin.execute<{ readonly running: boolean }>(
    'select ended_at is null as running from public.time_entries where id = $1',
    [entryId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]?.running === true;
}
export async function outcomes(w: TimeWorld, operationId: string): Promise<string[]> {
  const rows = await w.db.admin.execute<{ readonly outcome: string }>(
    `select outcome from public.audit_events where business_id = $1 and actor_id = $2
       and operation_id = $3 order by seq`,
    [w.alpha, w.clientA.actorId, operationId],
  );
  return rows.map((row) => row.outcome);
}
export function hidden(app: AppRealm, key: string): void {
  expect(app.view.text()).not.toContain(TITLE);
  expect(app.view.text()).not.toContain(key);
  const saved = app.storage.getItem(TIMER) ?? '';
  expect(saved).not.toContain(TITLE);
  expect(saved).not.toContain(key);
}

interface Delivery {
  loseStart: boolean;
  loseStop: boolean;
  held: ReturnType<typeof gate> | null;
  readonly answers: {
    readonly command: string;
    readonly answer: Awaited<ReturnType<TimeWorld['as']>>;
  }[];
}
function serveFrom(w: TimeWorld, sent: Sent[], state: Delivery): typeof globalThis.fetch {
  return async (url, init) => {
    const path = new URL(String(url), 'http://fixture.test').pathname.replace(
      /^.*?(\/[a-z]+\/[a-z_]+)$/u,
      '$1',
    );
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ path, body });
    if (path === '/task/read') {
      const read = await executeRead(w.db.app, w.alpha, w.clientA.presented, {
        read: 'task.read',
        recordId: String(body['recordId']),
      });
      return new Response(JSON.stringify(read), { status: isCommandRefusal(read) ? 404 : 200 });
    }
    if (path !== '/time/start' && path !== '/time/stop') return draftReply({ path, body });
    const command = path === '/time/start' ? 'time.start' : 'time.stop';
    const answer = await w.as(w.alpha, w.clientA, { ...body, command });
    state.answers.push({ command, answer });
    if (command === 'time.start' && state.loseStart) {
      state.loseStart = false;
      throw new TypeError('committed Start answer lost');
    }
    if (command === 'time.stop' && state.loseStop) {
      state.loseStop = false;
      throw new TypeError('committed Stop answer lost');
    }
    if (command === 'time.start' && state.held !== null) {
      const waiting = state.held;
      state.held = null;
      await waiting.held;
    }
    return new Response(JSON.stringify(answer), { status: isCommandRefusal(answer) ? 403 : 200 });
  };
}
async function readableTask(w: TimeWorld) {
  const taskId = await w.fresh(w.alpha, w.ada, TITLE);
  const grant = await w.db.app.withBusiness(
    w.alpha,
    async (tx) => await grantTo(tx, w.clientA, 'read', { kind: 'record', id: taskId }),
  );
  const readable = await executeRead(w.db.app, w.alpha, w.clientA.presented, {
    read: 'task.read',
    recordId: taskId,
  });
  if (!('task' in readable)) throw new Error('fixture task cannot be read');
  const key = readable.task.key;
  return { taskId, key, grant };
}
async function drained(app: AppRealm, pending: readonly Promise<Response>[]): Promise<void> {
  const before = pending.length;
  await app.act(async () => {
    await Promise.allSettled(pending);
  });
  await app.tick();
  if (pending.length !== before) await drained(app, pending);
}
export async function recoveryWorld(w: TimeWorld) {
  const { taskId, key, grant } = await readableTask(w);
  const sent: Sent[] = [];
  const pending: Promise<Response>[] = [];
  const readPending: Promise<Response>[] = [];
  const state: Delivery = { loseStart: true, loseStop: false, held: null, answers: [] };
  const serve = serveFrom(w, sent, state);
  const fetch: typeof globalThis.fetch = (url, init) => {
    const answer = serve(url, init);
    pending.push(answer);
    if (String(url).endsWith('/task/read')) readPending.push(answer);
    return answer;
  };
  return {
    taskId,
    key,
    fetch,
    sent,
    answers: state.answers,
    writes: () => sent.filter((request) => ['/time/start', '/time/stop'].includes(request.path)),
    drain: (app: AppRealm) => drained(app, pending),
    drainReads: (app: AppRealm) => drained(app, readPending),
    deny: async () => {
      await w.db.app.withBusiness(w.alpha, async (tx) => {
        await revokeGrant(tx, grant);
      });
    },
    loseStop: () => {
      state.loseStop = true;
    },
    holdReplay: () => {
      const next = gate();
      state.held = next;
      return next;
    },
  };
}
