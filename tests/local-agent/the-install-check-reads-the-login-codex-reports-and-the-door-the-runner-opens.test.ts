// SPDX-License-Identifier: AGPL-3.0-only
//
// The GPT runner's install check reads Codex's login status where Codex 0.162.1
// writes it (stderr), and certifies only a credential that opens the runner's
// door: the bearer key in the authorization header, never one the door answers
// 401. (The reviewer's two proofs on this change's first review, assertions
// unchanged.)
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRunner, type Runner } from '../../apps/local-agent/runner.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { parseCredentials, presented } from '../../packages/core-custody/src/credentials.ts';
import { LOCAL_GPT_PATH } from '../../packages/core-connectors/src/local-gpt.ts';
import { FAKE_CODEX, freePort, makeWorld, RUNNER_KEY, type World } from './world.ts';

const CHECK = resolve(import.meta.dirname, '../../scripts/m5/gpt-runner-install-check.sh');
const PORT = String(await freePort());
let world: World | undefined;
let runner: Runner | undefined;
afterEach(async () => {
  await runner?.close();
  world?.remove();
  runner = undefined;
  world = undefined;
});

function install(bin = FAKE_CODEX, header = 'authorization') {
  const w = makeWorld();
  world = w;
  chmodSync(w.agentHome, 0o700);
  chmodSync(w.codexHome, 0o700);
  const settingsFile = join(w.agentHome, 'settings.json');
  const credentialFile = join(w.agentHome, 'credentials.json');
  const env = {
    OPS_LOCAL_AGENT_SITE: 'm5',
    OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1',
    OPS_LOCAL_AGENT_HOME: w.agentHome,
    OPS_LOCAL_AGENT_CODEX_BIN: bin,
    OPS_LOCAL_AGENT_KEY: RUNNER_KEY,
    OPS_LOCAL_AGENT_PORT: PORT,
  };
  const credentials = [
    {
      ref: 'local_runner',
      kind: 'api_key',
      account: 'chatgpt-plan',
      destination: 'local_gpt',
      header,
      value: RUNNER_KEY,
    },
  ];
  writeFileSync(settingsFile, JSON.stringify(env), { mode: 0o600 });
  writeFileSync(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
  const checked = spawnSync('sh', [CHECK, settingsFile, credentialFile], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
  });
  return { w, env, credentials, checked };
}

it('the install check accepts a valid ChatGPT login reported on stderr', () => {
  // Codex 0.162.1 run_login_status uses eprintln for this successful status:
  // https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/cli/src/login.rs#L451-L453
  const w = makeWorld();
  const bin = join(w.agentHome, 'codex-status.mjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') process.stdout.write('codex-cli 0.162.1\\n');
else if (process.argv[2] === 'login' && process.argv[3] === 'status') process.stderr.write('Logged in using ChatGPT\\n');
else process.exitCode = 1;
`,
    { mode: 0o700 },
  );
  try {
    const { checked } = install(bin);
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toContain('gpt runner install check: passed');
  } finally {
    w.remove();
  }
});

it('the install check refuses a credential that cannot authenticate at the runner door', async () => {
  const { env, credentials, checked } = install(FAKE_CODEX, 'x-api-key');
  const parsed = parseCredentials(credentials);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.code);
  const credential = parsed.credentials.get('local_runner');
  if (credential === undefined) throw new Error('no credential');
  const settings = readSettings(env);
  if (!settings.ok) throw new Error(settings.code);
  runner = await createRunner(settings.settings, () => {});
  const reply = await fetch(`${runner.origin}${LOCAL_GPT_PATH}`, {
    method: 'POST',
    headers: { [credential.header]: presented(credential), 'content-type': 'application/json' },
    body: JSON.stringify({ fields: { message: 'Synthetic install probe.' } }),
  });
  expect(reply.status).toBe(401);
  await reply.text();
  expect(
    checked.status,
    'an installation that always receives HTTP 401 must fail preflight',
  ).not.toBe(0);
  expect(checked.stderr).toContain(
    'gpt runner install check: custody holds no credential, or another, for the runner’s door',
  );
});
