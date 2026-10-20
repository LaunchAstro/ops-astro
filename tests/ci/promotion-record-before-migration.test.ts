// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { promote, type PromotionEffects } from '../../scripts/ops/promotion.ts';
import { LINE, scratch, staged, stagingLine, STAGED, STORE } from './promotion.fixture.ts';

const OTHER_DIGEST = `sha256:${'2'.repeat(64)}`;
it.each([
  ['conflicting', stagingLine(STAGED, OTHER_DIGEST), 'refused'],
  ['malformed', '{"torn', 'refused'],
  ['invalid digest', stagingLine(STAGED, 'sha256:short'), 'refused'],
  ['unrelated version', stagingLine('fedcba987654', OTHER_DIGEST), 'promoted'],
] as const)(
  'judges %s content added during the service check before migration',
  async (_case, appended, kind) => {
    const root = STORE();
    const records = staged(root);
    const calls: string[] = [];
    const effects: PromotionEffects = {
      services() {
        calls.push('services');
        const line = typeof appended === 'string' ? appended : JSON.stringify(appended);
        appendFileSync(join(records, 'deployments.jsonl'), `${line}\n`);
        return [
          { manager: 'docker', name: 'prod-api', running: false },
          { manager: 'docker', name: 'prod-auth', running: false },
        ];
      },
      migrate() {
        calls.push('migrate');
        return true;
      },
      point() {
        calls.push('point');
      },
      start(service) {
        calls.push(`start ${service.name}`);
      },
      authorised: async (work) => await work(),
    };
    const outcome = await promote(
      {
        version: STAGED,
        store: root,
        records,
        line: LINE,
        dryRun: false,
        api: { manager: 'docker', name: 'prod-api' },
        auth: { manager: 'docker', name: 'prod-auth' },
        current: join(scratch, 'before-migration'),
      },
      effects,
    );
    expect(outcome.kind).toBe(kind);
    expect(calls).toEqual(
      kind === 'refused'
        ? ['services']
        : ['services', 'migrate', 'point', 'start prod-auth', 'start prod-api'],
    );
  },
);
