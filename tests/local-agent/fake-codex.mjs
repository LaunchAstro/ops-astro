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
import { appendFileSync, chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const home = process.env.CODEX_HOME ?? '';
const knobsFile = join(home, 'fake.json');
const knobs = existsSync(knobsFile) ? JSON.parse(readFileSync(knobsFile, 'utf8')) : {};

// `codex login status`: the login fake.json names (ChatGPT unless it says otherwise).
if (process.argv[2] === 'login') {
  const login = knobs.login ?? 'chatgpt';
  if (login === 'wrapper') {
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
  if (login === 'chatgpt' || login === 'loosen' || login === 'vanish') process.stdout.write('Logged in using ChatGPT\n');
  else if (login === 'apikey') process.stdout.write('Logged in using an API key - sk-proj-***\n');
  else process.stdout.write('Not logged in\n');
  process.exit(login === 'none' ? 1 : 0);
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
