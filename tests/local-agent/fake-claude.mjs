#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for Claude Code's `claude -p --output-format json`, for the local
// runner's tests: no model, no account, no spend. It reads its knobs from
// `fake.json` in its CLAUDE_CONFIG_DIR (the runner passes the child nothing
// else from its own environment), records each call (argv, stdin, env, cwd)
// to `calls.jsonl` there, and prints a result shaped like Claude Code's.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env['CLAUDE_CONFIG_DIR'] ?? '';
const knobsFile = join(dir, 'fake.json');
const knobs = existsSync(knobsFile) ? JSON.parse(readFileSync(knobsFile, 'utf8')) : {};

let input = '';
for await (const chunk of process.stdin) input += chunk;

const argv = process.argv.slice(2);
appendFileSync(
  join(dir, 'calls.jsonl'),
  `${JSON.stringify({ argv, stdin: input, env: process.env, cwd: process.cwd() })}\n`,
);

if (typeof knobs.sleepMs === 'number') {
  await new Promise((resolve) => {
    setTimeout(resolve, knobs.sleepMs);
  });
}
if (typeof knobs.exitCode === 'number') {
  process.stderr.write(knobs.stderr ?? 'fake failure');
  process.exit(knobs.exitCode);
}
if (typeof knobs.raw === 'string') {
  process.stdout.write(knobs.raw);
  process.exit(0);
}

const requested = argv[argv.indexOf('--model') + 1] ?? 'haiku';
const id = requested === 'haiku' ? 'claude-haiku-4-5-20251001' : requested;
const cost = typeof knobs.costUsd === 'number' ? knobs.costUsd : 0.0012;
process.stdout.write(
  JSON.stringify({
    type: 'result',
    subtype: knobs.isError === true ? 'error_during_execution' : 'success',
    is_error: knobs.isError === true,
    result: knobs.isError === true ? 'partial' : (knobs.text ?? `Answered: ${input}`),
    total_cost_usd: cost,
    usage: { input_tokens: 12, output_tokens: 7 },
    modelUsage: { [id]: { inputTokens: 12, outputTokens: 7, costUSD: cost } },
  }),
);
