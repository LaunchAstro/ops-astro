// SPDX-License-Identifier: AGPL-3.0-only
//
// Codex 0.162.1's app-server reports its remote-control status straight after
// `initialize`. That notice neither stops a call nor charges its prompt: a
// signed-out runner still says GPT_SIGNED_OUT and charges nothing. (The
// reviewer's proof on this change's second review, assertions unchanged.)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { answerOf, runnerWorld } from './runner-world.ts';

const { start, call } = runnerWorld();

// eslint-disable-next-line max-lines-per-function -- the reviewer's proof, kept whole
it('Codex 0.162.1 startup status does not reject and charge an unsent call', async () => {
  const { w, r } = await start({ OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1' });
  const binary = join(w.agentHome, 'startup-codex.mjs');
  // Replay the unsolicited notification observed from the release binary
  // immediately after initialize, using synthetic host and installation names.
  // This server has no account and never contacts a model.
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const home = process.env.CODEX_HOME;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(join(home, 'app-calls.jsonl'), JSON.stringify({ message }) + '\\n');
  if (message.method === 'initialize') {
    send({ id: message.id, result: {
      userAgent: 'ops-astro-local-agent/0.162.1 (Mac OS 26.5.2; arm64)',
      codexHome: home, platformFamily: 'unix', platformOs: 'macos'
    }});
    send({ method: 'remoteControl/status/changed', params: {
      status: 'disabled', serverName: 'offline-proof', installationId: 'synthetic', environmentId: null
    }});
  } else if (message.method === 'account/read') {
    send({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
  }
}
`,
    { mode: 0o700 },
  );
  // Settings are read at runner start. Reopen the same isolated home with
  // this protocol replay as its binary, without changing product code.
  await r.close();
  const { r: replay } = await start(
    {
      OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1',
      OPS_LOCAL_AGENT_CODEX_BIN: binary,
    },
    w,
  );
  const reply = await call(replay, { fields: { message: 'Offline proof.' }, stream: true });
  expect({
    answer: answerOf(reply.raw),
    asked: w.asked(),
    ledger: w.ledger().at(-1),
  }).toMatchObject({
    answer: { text: '', code: 'GPT_SIGNED_OUT' },
    asked: [],
    ledger: { inputTokens: 0, outputTokens: 0 },
  });
});
