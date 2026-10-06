#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for `codex exec --json` and `codex login status` (LA-1). An
// exec records what it was given (argv, stdin, environment, working folder)
// in its CODEX_HOME's calls.jsonl and answers as that folder's fake.json
// says: a reply, extra event lines, a tool item, a failed turn, the plan's
// usage limit, raw output, the tokens used, an exit code or a wait. The
// login answers as its `login` knob says. It never reaches a model.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.CODEX_HOME ?? '';
const knobsFile = join(home, 'fake.json');
const knobs = existsSync(knobsFile) ? JSON.parse(readFileSync(knobsFile, 'utf8')) : {};

// `codex login status`: the login fake.json names (ChatGPT unless it says otherwise).
if (process.argv[2] === 'login') {
  const login = knobs.login ?? 'chatgpt';
  if (login === 'chatgpt') process.stdout.write('Logged in using ChatGPT\n');
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
    `${JSON.stringify({ argv: process.argv.slice(2), stdin, env: process.env, cwd: process.cwd() })}\n`,
  );
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
