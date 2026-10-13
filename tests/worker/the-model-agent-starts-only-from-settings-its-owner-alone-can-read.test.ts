// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's process refuses to start, before any sign-in, custody or
// socket, when no settings file is named, when anyone but its owner can read
// the file, or when the settings name an Ollama off this machine's loopback.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../../apps/model-agent/main.ts';
import { carryKey } from './model-agent-world.ts';

let folder: string;
let errors: string[];

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'model-agent-settings-'));
  errors = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
    errors.push(String(text));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(folder, { recursive: true, force: true });
});

function settingsFile(mode: number, ollamaOrigin = 'http://127.0.0.1:11434'): string {
  const file = join(folder, 'settings.json');
  const settings = {
    business: '7d6f6c1e-8a51-4c43-9a3f-0b8f3c2d9e10',
    agent: '0c5b9a4e-2f1d-4e6b-8c7a-9d3e1f2a4b5c',
    // Nothing answers here: a start that got as far as signing in would fail differently.
    gotrueUrl: 'http://127.0.0.1:9/auth/v1',
    email: 'm5-models@example.test',
    password: 'a-long-agent-password',
    providerKey: '',
    realtimeUrl: 'ws://127.0.0.1:9/realtime/v1',
    carryKey: carryKey(),
    ollamaOrigin,
    credentialsFile: join(folder, 'credentials.json'),
    credentialRef: 'ollama_key',
  };
  writeFileSync(file, JSON.stringify(settings));
  chmodSync(file, mode);
  return file;
}

it('refuses with no settings file named', async () => {
  expect(await main({})).toBe(2);
  expect(errors.join('')).toContain('MODEL_AGENT_SETTINGS names no file');
});

it('refuses a settings file others can read', async () => {
  expect(await main({ MODEL_AGENT_SETTINGS: settingsFile(0o644) })).toBe(2);
  expect(errors.join('')).toContain('readable by others');
});

it('refuses an Ollama off loopback, naming the field and no value', async () => {
  const file = settingsFile(0o600, 'http://192.168.1.20:11434');
  expect(await main({ MODEL_AGENT_SETTINGS: file })).toBe(2);
  expect(errors.join('')).toContain('ollamaOrigin');
  expect(errors.join('')).not.toContain('192.168');
});

it('control: owner-only settings with loopback Ollama get as far as the sign-in', async () => {
  expect(await main({ MODEL_AGENT_SETTINGS: settingsFile(0o600) })).toBe(1);
  expect(errors.join('')).toContain('the agent login was refused');
  expect(errors.join('')).not.toContain('a-long-agent-password');
});
