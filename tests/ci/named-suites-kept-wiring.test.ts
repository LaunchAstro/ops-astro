// SPDX-License-Identifier: AGPL-3.0-only
//
// ORCH91 MAGNETS step 1: `database conformance gate` runs `node scripts/named-suites.ts kept
// <base>` on every event (named-suites-kept.test.ts runs the script). This reads how ci.yml wires
// it: through scripts/merge-group.mjs on a pull request or a merge group, as every step that reads
// a pull request's range must (merge-group-workflows.test.ts), and on a push from its `before`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '..', '..');

type Step = Record<string, unknown>;
// On a pull request or a group, merge-group.mjs runs the check once per pull request it judges; on
// a push the base is the push's `before`. A shell branch, as a step condition could skip a group.
const RUN = `if [ "$GITHUB_EVENT_NAME" = push ]; then
  node scripts/named-suites.ts kept "$BEFORE"
else
  node scripts/merge-group.mjs each sh -c 'node scripts/named-suites.ts kept "$BASE_SHA"'
fi
`;

describe('the wiring', () => {
  it('runs in the database conformance gate on every event, once per pull request on a pull request or a group, the push base through env', () => {
    const ci = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
      on: Record<string, unknown>;
      jobs: Record<string, { name?: string; if?: unknown; steps?: Step[] }>;
    };
    expect(Object.keys(ci.on).toSorted()).toStrictEqual(['merge_group', 'pull_request', 'push']);
    const job = ci.jobs['database-gate'];
    expect(job?.name).toBe('database conformance gate');
    expect(job).not.toHaveProperty('if');
    const steps = job?.steps ?? [];
    // merge-group.mjs walks a group's first parents to the base tip: a depth-1 head has none.
    const checkout = steps.find((s) => String(s['uses']).startsWith('actions/checkout@'));
    expect(checkout?.['with']).toStrictEqual({ 'fetch-depth': 0 });
    const runs = steps.filter((s) => String(s['run']).includes('named-suites.ts kept'));
    expect(runs).toHaveLength(1);
    const step = runs[0] ?? {};
    expect(step['name']).toBe('No named or isolation suite is dropped');
    expect(step['run']).toBe(RUN);
    expect(step).not.toHaveProperty('if');
    expect(step).not.toHaveProperty('continue-on-error');
    // The event's values reach the step through env alone; the script validates, then calls git.
    expect(step['env']).toStrictEqual({ BEFORE: '${{ github.event.before }}' });
    for (const s of steps) expect(String(s['run'] ?? '')).not.toContain('${{');
    const node = steps.findIndex((s) => String(s['uses']).startsWith('actions/setup-node@'));
    expect(node).toBeGreaterThan(-1);
    expect(steps.indexOf(step)).toBeGreaterThan(node);
  });
});
