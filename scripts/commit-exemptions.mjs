// SPDX-License-Identifier: AGPL-3.0-only
//
// The commits whose messages the range check does not hand to commitlint: a
// closed list in commit-message-exemptions.json, each a full SHA with its
// reason (owner ruling ORCH47, 1 Oct 2026). Provenance still applies to them.
// A short, upper-case or reasonless entry is refused, so the list cannot widen
// by prefix or by accident.
import { readFileSync } from 'node:fs';

const FULL_SHA = /^[0-9a-f]{40}$/u;

/** The exempt SHAs in `text`; throws on any entry that is not a full SHA with a reason. */
export function parseExemptions(text) {
  const { commits } = JSON.parse(text);
  if (!Array.isArray(commits)) throw new Error('commit exemptions: `commits` is not a list');
  return new Set(
    commits.map((entry, index) => {
      if (typeof entry?.sha !== 'string' || !FULL_SHA.test(entry.sha)) {
        throw new Error(`commit exemptions: entry ${index} is not a full 40-character SHA`);
      }
      if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
        throw new Error(`commit exemptions: entry ${index} gives no reason`);
      }
      return entry.sha;
    }),
  );
}

export const readExemptions = () =>
  parseExemptions(readFileSync(new URL('commit-message-exemptions.json', import.meta.url), 'utf8'));
