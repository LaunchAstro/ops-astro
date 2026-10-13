// SPDX-License-Identifier: AGPL-3.0-only
//
// Before the GPT runner's LaunchAgent is loaded on the M5
// (docs/local/GPT-RUNNER.md), its install check passes only when: the settings
// and credential files are readable by their owner alone; the settings are the
// M5 site's, with the Codex version pinned; the runner's home and Codex home
// are private and hold no instructions or config; Codex is the pinned version
// and signed in to the ChatGPT plan; and custody's credential file holds the
// runner's own key for its door. It prints a kind, never a value. The plist
// names the settings file and holds no setting's value itself.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_CODEX, makeWorld, RUNNER_KEY, type World } from './world.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const CHECK = join(ROOT, 'scripts/m5/gpt-runner-install-check.sh');

let world: World | undefined;
afterEach(() => {
  world?.remove();
  world = undefined;
});

interface Install {
  readonly settings: Record<string, string>;
  readonly credentials: unknown;
  readonly settingsMode: number;
  readonly homeMode: number;
  readonly plant: string | null;
  readonly knobs: Record<string, unknown>;
}

const GOOD: Install = {
  settings: {},
  credentials: null,
  settingsMode: 0o600,
  homeMode: 0o700,
  plant: null,
  knobs: {},
};

/** The check run on an M5 set up as `install` says: its exit, and all it printed. */
function check(install: Partial<Install> = {}): { code: number; output: string } {
  const w = makeWorld();
  world = w;
  const { settings, credentials, settingsMode, homeMode, plant, knobs } = { ...GOOD, ...install };
  chmodSync(w.agentHome, homeMode);
  chmodSync(w.codexHome, 0o700);
  w.knobs(knobs);
  if (plant !== null) writeFileSync(join(w.codexHome, plant), 'planted');
  const dir = join(w.userHome, 'config');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settingsFile = join(dir, 'gpt-runner.json');
  writeFileSync(
    settingsFile,
    JSON.stringify({
      OPS_LOCAL_AGENT_SITE: 'm5',
      OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1',
      OPS_LOCAL_AGENT_HOME: w.agentHome,
      OPS_LOCAL_AGENT_CODEX_BIN: FAKE_CODEX,
      OPS_LOCAL_AGENT_KEY: RUNNER_KEY,
      ...settings,
    }),
  );
  chmodSync(settingsFile, settingsMode);
  const credentialFile = join(dir, 'credentials.json');
  const filed = credentials ?? [
    {
      ref: 'local_runner',
      kind: 'api_key',
      account: 'chatgpt-plan',
      destination: 'local_gpt',
      header: 'authorization',
      value: RUNNER_KEY,
    },
  ];
  writeFileSync(credentialFile, JSON.stringify(filed));
  chmodSync(credentialFile, 0o600);
  try {
    const output = execFileSync('sh', [CHECK, settingsFile, credentialFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: w.userHome },
    });
    return { code: 0, output };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { code: failed.status, output: `${failed.stdout}${failed.stderr}` };
  }
}

describe('the GPT runner install check', () => {
  it('passes an M5 set up as the runner needs', () => {
    const { code, output } = check();
    expect(output).toContain('gpt runner install check: passed');
    expect(code).toBe(0);
  });

  it.each([
    ['a settings file others can read', { settingsMode: 0o644 }],
    ['a runner home others can open', { homeMode: 0o755 }],
    ['instructions in the Codex home', { plant: 'AGENTS.md' }],
    ['a config in the Codex home', { plant: 'config.toml' }],
    ['another Codex version', { knobs: { version: '0.163.0' } }],
    ['Codex signed in with an API key', { knobs: { login: 'apikey' } }],
    ['Codex not signed in', { knobs: { login: 'none' } }],
    ['settings that are not the M5 site’s', { settings: { OPS_LOCAL_AGENT_SITE: '' } }],
    ['no Codex version pinned', { settings: { OPS_LOCAL_AGENT_CODEX_VERSION: '' } }],
    ['no credential for the runner’s door', { credentials: [] }],
    [
      'a credential for the door that is not the runner’s key',
      {
        credentials: [
          {
            ref: 'local_runner',
            kind: 'api_key',
            destination: 'local_gpt',
            value: 'another-key-0123456789abcdef01234567',
          },
        ],
      },
    ],
  ])('refuses %s, printing no value', (_label, install) => {
    const { code, output } = check(install);
    expect(code).not.toBe(0);
    expect(output).toContain('gpt runner install check:');
    expect(output).not.toContain('passed');
    expect(output).not.toContain(RUNNER_KEY);
  });
});

describe("the GPT runner's plist", () => {
  const plist = readFileSync(join(ROOT, 'deploy/m5/ops-astro-gpt-runner.plist'), 'utf8');

  it('runs the runner on its settings file, kept alive', () => {
    expect(plist).toContain('<string>apps/local-agent/main.ts</string>');
    expect(plist).toContain('<key>OPS_LOCAL_AGENT_SETTINGS</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
  });

  it('holds no setting’s value, the key above all', () => {
    expect(plist).not.toContain('OPS_LOCAL_AGENT_KEY');
    expect(plist).not.toMatch(/<key>OPS_LOCAL_AGENT_(?!SETTINGS)/u);
  });
});
