#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// The fake codex's `app-server` half (fake-codex.mjs): one JSON-RPC message per
// line each way on stdio. Every message it receives goes to its CODEX_HOME's
// app-calls.jsonl, after one line naming its argv, environment and folder. It
// never reaches a model or an account.

import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The Codex home and fake.json's knobs, set when the app-server starts. */
let home = '';
let knobs = {};

function sendLine(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function notify(method, params) {
  sendLine({ method, params });
}
async function pause(ms) {
  await new Promise((done) => {
    setTimeout(done, ms);
  });
}
/** The one thread and turn the stand-in plays. */
function ids() {
  return { threadId: 'th-1', turnId: 'tu-1' };
}

/** A file's arrival, looked for every 10 ms. */
export async function until(file) {
  // eslint-disable-next-line no-await-in-loop -- polls, one look at a time
  while (!existsSync(file)) await pause(10);
}

/** One agent message: started, each delta (`afterFirst` awaited after the first), completed. */
async function agentMessage(id, deltas, text, afterFirst) {
  notify('item/started', {
    ...ids(),
    startedAtMs: 0,
    item: { id, type: 'agentMessage', text: '' },
  });
  for (const [index, delta] of deltas.entries()) {
    notify('item/agentMessage/delta', { ...ids(), itemId: id, delta });
    // eslint-disable-next-line no-await-in-loop -- the gate holds the stream after its first piece
    if (index === 0) await afterFirst();
  }
  notify('item/completed', { ...ids(), item: { id, type: 'agentMessage', text } });
}

/** The tokens and the turn's end, failed when `turnError` says so. */
function endTurn() {
  if (!knobs.noUsage) {
    const used = knobs.usage ?? { input: 120, output: 7 };
    const breakdown = {
      inputTokens: used.input,
      outputTokens: used.output,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: used.input + used.output,
    };
    notify('thread/tokenUsage/updated', {
      ...ids(),
      tokenUsage: { last: breakdown, total: breakdown },
    });
  }
  const failed = knobs.turnError !== undefined;
  const turn = { id: ids().turnId, items: [], status: failed ? 'failed' : 'completed' };
  notify('turn/completed', {
    threadId: ids().threadId,
    turn: { ...turn, error: failed ? knobs.turnError : null },
  });
}

/**
 * The plan's usage reading: `weekly` and `fiveHour` percentages (20 and 10),
 * `noWeekly` no weekly window, `swap` the weekly one first, `permission` the ordinary-usage permission
 * (true; `'absent'` leaves it out), `reached` a limit reached.
 */
function usageWindow(usedPercent, windowDurationMins) {
  return { usedPercent, windowDurationMins, resetsAt: 1_760_400_000 };
}

function rateLimits() {
  const fiveHour = usageWindow(knobs.fiveHour ?? 10, 300);
  const weekly = knobs.noWeekly ? null : usageWindow(knobs.weekly ?? 20, 10_080);
  // `swap`: the weekly window reported as the primary one; the order is not by length.
  const snapshot = {
    primary: knobs.swap ? weekly : fiveHour,
    secondary: knobs.swap ? fiveHour : weekly,
    rateLimitReachedType: knobs.reached ?? null,
    planType: 'pro',
  };
  const permission = knobs.permission === undefined ? true : knobs.permission;
  return permission === 'absent'
    ? { rateLimits: snapshot }
    : { rateLimits: snapshot, ordinaryUsageAllowed: permission };
}

/** The turn fake.json describes. */
async function playTurn() {
  if (typeof knobs.raw === 'string') {
    process.stdout.write(knobs.raw);
    return;
  }
  notify('turn/started', {
    threadId: ids().threadId,
    turn: { id: ids().turnId, items: [], status: 'inProgress' },
  });
  // The call's own input, echoed as the user's message, as 0.162.1 does on every turn.
  const echoed = { id: 'um-1', type: 'userMessage', content: [] };
  notify('item/started', { ...ids(), startedAtMs: 0, item: echoed });
  notify('item/completed', { ...ids(), item: echoed });
  for (const [method, params] of knobs.before ?? []) notify(method, { ...ids(), ...params });
  // `deltas: null`: the turn gives no agent message at all.
  const deltas = knobs.deltas === undefined ? ['Two tasks', ' are due.'] : knobs.deltas;
  if (deltas !== null) {
    await agentMessage('am-1', deltas, knobs.text ?? deltas.join(''), async () => {
      if (knobs.serverRequest) await ask(knobs.serverRequest);
      if (knobs.gate) await until(knobs.gate);
    });
  }
  if (knobs.second) await agentMessage('am-2', knobs.second, knobs.second.join(''), async () => {});
  endTurn();
}

/** The server's own requests awaiting the runner's reply, by id. */
const waiting = new Map();

/** A request of the server's own (`serverRequest`), answered before the turn goes on. */
async function ask(method) {
  const answered = new Promise((done) => {
    waiting.set('srv-1', done);
  });
  sendLine({ id: 'srv-1', method, params: { ...ids() } });
  await answered;
}

/** What each request the runner may make is answered with; the turn's is played after. */
const RESULTS = {
  initialize: () => ({
    userAgent: knobs.userAgent ?? 'codex_cli_rs/0.162.1 (Mac OS 26.5.0; arm64)',
    // `codexHome`: a home other than the one it was started on.
    codexHome: knobs.codexHome ?? home,
    platformFamily: 'unix',
    platformOs: 'macos',
  }),
  // `signedOut`: no account; `account`: another one (an API key's).
  'account/read': () => ({
    account: knobs.signedOut
      ? null
      : (knobs.account ?? { type: 'chatgpt', email: null, planType: 'pro' }),
    requiresOpenaiAuth: true,
  }),
  'account/rateLimits/read': () => rateLimits(),
  'thread/start': (params) => ({
    thread: { id: ids().threadId, ephemeral: true },
    model: params?.model,
  }),
  'turn/start': () => ({ turn: { id: ids().turnId, items: [], status: 'inProgress' } }),
};

/** One message from the runner: a reply to the server's own request, or a request answered. */
async function answer({ id, method, params }) {
  if (id !== undefined && method === undefined) {
    waiting.get(id)?.();
    return;
  }
  if (id === undefined) return;
  const result = RESULTS[method];
  if (result === undefined) {
    sendLine({ id, error: { code: -32601, message: 'unknown method' } });
    return;
  }
  // `prepMs`: a slow preparation, the thread's answer held this long.
  if (method === 'thread/start' && knobs.prepMs) await pause(knobs.prepMs);
  sendLine({ id, result: result(params) });
  // `afterInit`: notifications sent straight after `initialize`'s answer, as 0.162.1 sends its
  // remote-control status (`remoteControl`: that status; `disabled` unless it says otherwise).
  if (method === 'initialize') {
    notify('remoteControl/status/changed', {
      installationId: 'inst-1',
      serverName: 'stand-in',
      status: knobs.remoteControl ?? 'disabled',
    });
    for (const [name, extra] of knobs.afterInit ?? []) notify(name, extra);
  }
  if (method !== 'turn/start') return;
  if (knobs.waitMs) await pause(knobs.waitMs);
  await playTurn();
}

/**
 * A stand-in for `codex app-server` on stdio. It answers `initialize`,
 * `account/read`, `account/rateLimits/read`, `thread/start` and `turn/start`,
 * then plays the turn fake.json describes: `deltas` of one agent message (its
 * `text` the joined deltas unless set), `before` notifications ahead of it,
 * `second` a second agent message, `serverRequest` a request of its own after
 * the first delta, `gate` a file it waits for after the first delta,
 * `turnError` a failed turn, `noUsage` no token report, `usage` the tokens,
 * `raw` lines written as they are; `prepMs` holds the thread's answer.
 */
export async function appServer(codexHome, settings) {
  home = codexHome;
  knobs = settings;
  const record = (entry) =>
    appendFileSync(join(home, 'app-calls.jsonl'), `${JSON.stringify(entry)}\n`);
  record({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid });
  let buffered = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.trim() === '') continue;
      const message = JSON.parse(line);
      record({ message });
      void answer(message);
    }
  }
}
