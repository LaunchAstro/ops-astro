// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's runbook says who sees each alert (#1736), and never passes off
// `alerts.mjs plan`, which only prints what to set up, as a delivery proof.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const README = readFileSync('deploy/production/README.md', 'utf8');
const ALERTS = README.split(/^## /mu).find((section) => section.startsWith('Alerts\n')) ?? '';

describe("production runbook's alerts", () => {
  it('names the owner and the second operator as who sees every alert in its table', () => {
    const rows = ALERTS.split('\n').filter(
      (line) => line.startsWith('| ') && !line.includes('---'),
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(1)) {
      expect(row).toContain('the owner and the second operator');
    }
  });

  it('does not describe the print-only plan as sending mail or registering checks', () => {
    const planSentences = ALERTS.replace(/\s+/gu, ' ')
      .split(/(?<=\.) /u)
      .filter((sentence) => /\bplan\b/u.test(sentence));
    expect(planSentences.length).toBeGreaterThan(0);
    for (const sentence of planSentences) {
      expect(sentence).not.toMatch(/\b(mails?|sends?|registers?|checks production)\b/u);
    }
    expect(ALERTS).toMatch(/prints/u);
  });
});
