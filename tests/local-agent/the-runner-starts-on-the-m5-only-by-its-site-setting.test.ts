// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT on the owner's plan, carried to the M5: the runner starts on the
// owner's laptop (OPS_ENVIRONMENT=local) as before, or on the M5 by its own
// site setting, with the Codex version it runs pinned. It never starts on a
// hosted function. A streamed call checks the version Codex reports, and the
// Codex home it runs on, before the model is asked anything.

import { describe, expect, it } from 'vitest';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { answerOf, runnerWorld } from './runner-world.ts';
import { makeWorld } from './world.ts';

const M5 = { OPS_ENVIRONMENT: 'production', OPS_LOCAL_AGENT_SITE: 'm5' };

describe("the runner's site", () => {
  it.each([
    ['a hosted environment alone', { OPS_ENVIRONMENT: 'production' }],
    ['a site that is not the M5', { ...M5, OPS_LOCAL_AGENT_SITE: 'elsewhere' }],
    [
      'the M5 site on a hosted function',
      { ...M5, OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1', VERCEL: '1' },
    ],
    ['the M5 site with no Codex version pinned', M5],
    [
      'the M5 site with a version that is not one',
      { ...M5, OPS_LOCAL_AGENT_CODEX_VERSION: 'latest' },
    ],
  ])('refuses %s', (_label, overrides) => {
    const w = makeWorld();
    try {
      expect(readSettings({ ...w.env, ...overrides }, w.userHome).ok).toBe(false);
    } finally {
      w.remove();
    }
  });

  it('starts on the M5 site with its Codex version pinned', () => {
    const w = makeWorld();
    try {
      const read = readSettings(
        { ...w.env, ...M5, OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1' },
        w.userHome,
      );
      expect(read.ok && read.settings.codexVersion).toBe('0.162.1');
    } finally {
      w.remove();
    }
  });
});

const { start, call } = runnerWorld();
const message = { fields: { message: 'What is on the board today?' }, stream: true };

describe('a streamed call on a Codex the runner does not expect', () => {
  it.each([
    ['another version', { userAgent: 'codex_cli_rs/0.163.0 (Mac OS 26.5.0; arm64)' }],
    ['another Codex home', { codexHome: '/elsewhere/codex' }],
    ['a version with more after it', { userAgent: 'codex_cli_rs/0.162.1-patched (Mac OS)' }],
    ['no version at all', { userAgent: 'codex_cli_rs' }],
  ])('asks the model nothing on %s', async (_label, knobs) => {
    const { w, r } = await start({ OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1' });
    w.knobs(knobs);
    const reply = await call(r, message);
    expect(answerOf(reply.raw)).toMatchObject({ text: '', code: 'LOCAL_GPT_FAILED' });
    expect(w.asked()).toEqual([]);
  });

  it('asks the model on the pinned version in its own home', async () => {
    const { w, r } = await start({ OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1' });
    const reply = await call(r, message);
    expect(answerOf(reply.raw)).toMatchObject({ code: null });
    expect(w.asked()).toHaveLength(1);
  });
});
