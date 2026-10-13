#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for `codex exec --json` and `codex login status` (LA-1). An
// exec records what it was given (argv, stdin, environment, working folder)
// and its pid in its CODEX_HOME's calls.jsonl and answers as that folder's
// fake.json says: a reply, extra event lines, a tool item, a failed turn, the
// plan's usage limit, raw output, the tokens used, an exit code or a wait.
// The login answers as its `login` knob says; `wrapper` is a wrapper whose
// descendant holds its output open and never answers (`escaped`: from a
// process group of its own); `loosen` opens the home while it answers;
// `vanish` removes it. It never reaches a model.

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const home = process.env.CODEX_HOME ?? '';
const knobsFile = join(home, 'fake.json');
const knobs = existsSync(knobsFile) ? JSON.parse(readFileSync(knobsFile, 'utf8')) : {};

// `codex login status`: the login fake.json names (ChatGPT unless it says otherwise).
if (process.argv[2] === 'login') {
  const login = knobs.login ?? 'chatgpt';
  if (login === 'wrapper') {
    writeFileSync(join(home, 'wrapper.pid'), String(process.pid));
    const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    writeFileSync(join(home, 'descendant.pid'), String(descendant.pid));
    await new Promise(() => {});
  }
  if (login === 'escaped') {
    // A descendant in a process group of its own, so no kill of the wrapper's group reaches it.
    const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    });
    writeFileSync(join(home, 'descendant.pid'), String(descendant.pid));
    await new Promise(() => {});
  }
  // `loosen`: signed in, but the runner's home is opened to others while the check runs.
  if (login === 'loosen') chmodSync(dirname(home), 0o777);
  // `vanish`: signed in, but the runner's home is gone by the time it answers.
  if (login === 'vanish') rmSync(dirname(home), { recursive: true, force: true });
  if (login === 'chatgpt' || login === 'loosen' || login === 'vanish')
    process.stdout.write('Logged in using ChatGPT\n');
  else if (login === 'apikey') process.stdout.write('Logged in using an API key - sk-proj-***\n');
  else process.stdout.write('Not logged in\n');
  process.exit(login === 'none' ? 1 : 0);
}

// `codex app-server` over stdio: one JSON-RPC message per line each way (appServer below).
if (process.argv[2] === 'app-server') {
  await appServer();
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', () => {
  appendFileSync(
    join(home, 'calls.jsonl'),
    `${JSON.stringify({ argv: process.argv.slice(2), stdin, env: process.env, cwd: process.cwd(), pid: process.pid })}\n`,
  );
  // As codex 0.160.1 does under `forced_login_method="chatgpt"` (probed with a
  // worthless key): a saved API-key login is logged out, and nothing is asked.
  if (knobs.login === 'apikey' && process.argv.includes('forced_login_method="chatgpt"')) {
    process.stderr.write(
      'ChatGPT login is required, but an API key is currently being used. Logging out.\n',
    );
    process.exit(1);
  }
  if (knobs.login === 'apikey')
    appendFileSync(join(home, 'billed.jsonl'), `${JSON.stringify(stdin)}\n`);
  const answer = () => {
    if (knobs.limit) {
      const limit = { type: 'error', message: "You've hit your usage limit. Try again later." };
      process.stdout.write(
        `${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify(limit)}\n`,
      );
    } else if (typeof knobs.raw === 'string') {
      process.stdout.write(knobs.raw);
    } else {
      const lines = [
        { type: 'thread.started', thread_id: 't-1' },
        { type: 'turn.started' },
        ...(knobs.before ?? []),
        {
          type: 'item.completed',
          item: { id: 'i-1', type: 'agent_message', text: knobs.text ?? 'Local reply.' },
        },
        knobs.failed
          ? { type: 'turn.failed', error: { message: 'failed' } }
          : {
              type: 'turn.completed',
              usage: knobs.usage ?? { input_tokens: 120, output_tokens: 7 },
            },
      ];
      if (knobs.failed)
        lines.push({ type: 'turn.completed', usage: { input_tokens: 90, output_tokens: 0 } });
      for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
    }
    process.exit(knobs.exit ?? 0);
  };
  if (knobs.waitMs) setTimeout(answer, knobs.waitMs);
  else answer();
});

// Hoisted declarations: the app-server branch runs from the top of this file.
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
async function until(file) {
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

/** The turn fake.json describes; `ask` sends a request of the server's own and waits for its reply. */
async function playTurn(ask) {
  if (typeof knobs.raw === 'string') {
    process.stdout.write(knobs.raw);
    return;
  }
  notify('turn/started', {
    threadId: ids().threadId,
    turn: { id: ids().turnId, items: [], status: 'inProgress' },
  });
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

/**
 * A stand-in for `codex app-server` on stdio. Every message it receives goes
 * to its CODEX_HOME's app-calls.jsonl, after one line naming its argv,
 * environment and working folder. It answers `initialize`, `thread/start` and
 * `turn/start`, then plays the turn fake.json describes: `deltas` of one agent
 * message (its `text` the joined deltas unless set), `before` notifications
 * ahead of it, `second` a second agent message, `serverRequest` a request of
 * its own after the first delta, `gate` a file it waits for after the first
 * delta, `turnError` a failed turn, `noUsage` no token report, `usage` the
 * tokens, `raw` lines written as they are.
 */
async function appServer() {
  const record = (entry) =>
    appendFileSync(join(home, 'app-calls.jsonl'), `${JSON.stringify(entry)}\n`);
  record({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid });
  const waiting = new Map();
  const ask = async (method) => {
    const answered = new Promise((done) => {
      waiting.set('srv-1', done);
    });
    sendLine({ id: 'srv-1', method, params: { ...ids() } });
    await answered;
  };
  const answer = async ({ id, method, params }) => {
    if (method === 'initialize') {
      const userAgent = knobs.userAgent ?? 'codex_cli_rs/0.162.1 (Mac OS 26.5.0; arm64)';
      sendLine({
        id,
        result: { userAgent, codexHome: home, platformFamily: 'unix', platformOs: 'macos' },
      });
    } else if (method === 'thread/start') {
      sendLine({
        id,
        result: { thread: { id: ids().threadId, ephemeral: true }, model: params?.model },
      });
    } else if (method === 'turn/start') {
      sendLine({ id, result: { turn: { id: ids().turnId, items: [], status: 'inProgress' } } });
      if (knobs.waitMs) await pause(knobs.waitMs);
      await playTurn(ask);
    } else if (id !== undefined && method === undefined) {
      waiting.get(id)?.();
    } else if (id !== undefined) {
      sendLine({ id, error: { code: -32601, message: 'unknown method' } });
    }
  };
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
