// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P2: the owner's sign-in checklist says how he signs in on the
// headless M5 (an SSH tunnel, Screen Sharing as fallback), which plan, how
// his consent for background use is given and recorded, the Time Machine
// exclusion and its check, the ancestor folders check, and what each refusal
// the sign-in can answer means. It never asks for a key in chat.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const page = readFileSync(resolve(ROOT, 'docs/local/chatgpt-plan.md'), 'utf8');
const code = ['apps/model-agent/chatgpt-sign-in.ts', 'packages/core-custody/src/plan-sign-in.ts']
  .map((file) => readFileSync(resolve(ROOT, file), 'utf8'))
  .join('\n');

describe("the owner's sign-in checklist", () => {
  it('names the SSH tunnel to the loopback port, with Screen Sharing as the fallback, and no device code', () => {
    expect(page).toContain('ssh -L 127.0.0.1:1455:127.0.0.1:1455 <m5>');
    expect(page).toContain('Screen Sharing');
    expect(page).toContain('no device code');
    expect(page).toContain('http://127.0.0.1:<port>/auth/callback');
    expect(page).toMatch(/codex login/u);
  });

  it('names the plan and records the consent for background use', () => {
    expect(page).toMatch(/Plus or Pro/u);
    expect(page).toContain('Business workspace');
    expect(page).toContain('--consent-background-use');
    expect(page).toMatch(/I, the owner, consent to Ops Astro using my ChatGPT plan/u);
    expect(page).toContain('#1705');
  });

  it('carries the Time Machine exclusion and its check, and the ancestor folders check', () => {
    expect(page).toContain('tmutil addexclusion ~/.ops-astro');
    expect(page).toContain('tmutil isexcluded ~/.ops-astro');
    expect(page).toContain('`[Excluded]`');
    expect(page).toContain('ls -lde "$d"');
    expect(page).toMatch(/owned by you or by `root`/u);
  });

  it('runs the command the repository holds, with the consent flag', () => {
    expect(page).toContain(
      'node apps/model-agent/chatgpt-sign-in-command.ts --consent-background-use',
    );
    expect(
      readFileSync(resolve(ROOT, 'apps/model-agent/chatgpt-sign-in-command.ts'), 'utf8'),
    ).toContain("'--consent-background-use'");
  });

  it('explains every refusal the sign-in can answer to the owner', () => {
    const codes = new Set(code.match(/'SIGN_IN_[A-Z_]+'/gu)?.map((c) => c.slice(1, -1)));
    // The command pins OpenAI's origin, and custody's other-account verdict reaches the owner as ACCOUNT_CHANGED.
    codes.delete('SIGN_IN_ISSUER_REFUSED');
    codes.delete('SIGN_IN_OTHER_ACCOUNT');
    codes.add('SIGN_IN_CONSENT_NEEDED');
    for (const name of codes) expect(page, name).toContain(`\`${name}\``);
  });

  it('never asks for a token, a code or the token file in chat', () => {
    expect(page).toMatch(/Never paste a token, a code or the token file into chat/u);
    expect(page).not.toMatch(/paste (?:the|your) (?:token|key|code)/iu);
  });
});
