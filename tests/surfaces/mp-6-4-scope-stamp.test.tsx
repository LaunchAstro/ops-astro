// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-4, the scope stamp's named tests over lineages shaped exactly as
// `task.read` returns them: what the run was allowed to touch, from its
// lease's delegation, read-only. The server side (the delegation read in the
// proposals' snapshot, and a person's edits never reaching it) is proven
// against Postgres in `tests/api/mp-6-4-scope.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import type { RunScope } from '../../packages/ui/src/index.ts';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

const TASK = 'task-a';

function scope(overrides: Partial<NonNullable<RunScope['delegation']>> = {}): RunScope {
  return {
    leaseId: 'lease-1',
    acquiredAt: '2026-09-29T09:00:00.000Z',
    delegation: {
      id: 'deleg-1',
      purpose: 'draft_the_reply',
      scope: { kind: 'record', id: TASK },
      pairs: [
        { collection: 'task', action: 'read' },
        { collection: 'task', action: 'comment' },
        { collection: 'task', action: 'write' },
      ],
      expiresAt: '2026-09-29T10:00:00.000Z',
      state: 'live',
      delegatePersonId: 'p-ada',
      grants: [
        { id: 'grant-business', collection: 'task', action: 'write', scopeKind: 'business' },
        { id: 'grant-record', collection: 'task', action: 'comment', scopeKind: 'record' },
      ],
      ...overrides,
    },
  };
}

// eslint-disable-next-line max-lines-per-function -- one stamp, each line of it
describe('MP-6-4 scope stamp', () => {
  it('MP-6-4 machine-set stamp', async () => {
    const page = await pane({
      lineages: [lineage({ scopes: [scope()] })],
      ledgerHref: (grantId) => `/ledger#${grantId}`,
    });
    const stamp = page.find('[data-agent="scope"]');
    expect((stamp as HTMLElement | null)?.dataset['scope']).toBe('agent');
    expect(page.all('[data-scope-part]').map((part) => part.textContent)).toStrictEqual([
      'this task only',
      'draft the reply',
      'read · comment · write',
    ]);
    expect(page.find('[data-agent="scope-say"]')?.textContent).toContain(
      'a task may narrow what its grant allows, never widen it',
    );
    // Its link: each grant the delegation draws on, into the access ledger.
    expect(
      page.all('[data-agent="scope-say"] a').map((link) => link.getAttribute('href')),
    ).toStrictEqual(['/ledger#grant-business', '/ledger#grant-record']);
    // Read-only: the stamp offers no control of any kind.
    expect(page.all('[data-agent="scope"] button, [data-agent="scope"] input')).toHaveLength(0);
    expect(page.all('[data-agent="scope"] select, [data-agent="scope"] textarea')).toHaveLength(0);
  });

  it('MP-6-4 names each grant unlinked while the ledger has no screen', async () => {
    const page = await pane({ lineages: [lineage({ scopes: [scope()] })] });
    expect(page.all('[data-agent="scope-say"] a')).toHaveLength(0);
    expect(page.all('[data-ledger-grant]').map((grant) => grant.textContent?.trim())).toStrictEqual(
      ['task write, business-wide', 'task comment, this task'],
    );
  });

  it('MP-6-4 the snapshot line', async () => {
    const page = await pane({ lineages: [lineage({ scopes: [scope()] })] });
    expect(page.find('[data-agent="snapshot-line"]')?.textContent).toBe(
      `Context snapshot v1 ${version().payloadDigest.slice(0, 12)} · pinned 2026-09-29T09:00:00.000Z`,
    );
  });

  it('MP-6-4 the granted scope facts', async () => {
    const page = await pane({ lineages: [lineage({ scopes: [scope()] })] });
    const fact = (name: string): string =>
      page.find(`[data-scope-fact="${name}"] .sb__state`)?.textContent ?? '';
    expect(fact('write')).toBe('Granted for this run.');
    expect(fact('grant')).toBe('Delegation deleg-1 from person p-ada');
    expect(fact('constraints')).toContain('Reaches task (read, comment, write) on this task only.');
    expect(fact('constraints')).toContain('Never wider than person p-ada’s own live grants.');
    expect(fact('constraints')).toContain('Until 2026-09-29T10:00:00.000Z.');

    const narrow = await pane({
      lineages: [
        lineage({
          scopes: [scope({ pairs: [{ collection: 'task', action: 'read' }], state: 'revoked' })],
        }),
      ],
    });
    const narrowFact = (name: string): string =>
      narrow.find(`[data-scope-fact="${name}"] .sb__state`)?.textContent ?? '';
    expect(narrowFact('write')).toBe('None. This run can read and stage, and cannot publish.');
    expect(narrowFact('constraints')).toContain('No longer live: revoked.');
  });

  it('MP-6-4 run:write is named beside the task, never folded into its clearance', async () => {
    // Out of the model's order on purpose: the stamp orders them itself.
    const page = await pane({
      lineages: [
        lineage({
          scopes: [
            scope({
              pairs: [
                { collection: 'run', action: 'write' },
                { collection: 'task', action: 'comment' },
                { collection: 'task', action: 'read' },
                { collection: 'task', action: 'write' },
              ],
            }),
          ],
        }),
      ],
    });
    expect(page.find('[data-scope-part="clearance"]')?.textContent).toBe('read · comment · write');
    expect(page.find('[data-scope-fact="constraints"] .sb__state')?.textContent).toContain(
      'Reaches task (read, comment, write) and run (write) on this task only.',
    );
  });

  it('MP-6-4 the newest lease is the stamp, and no lease is no scope', async () => {
    const none = await pane();
    expect(none.find('[data-agent="scope"]')?.textContent).toBe(
      'No scope has been issued on this task yet.',
    );
    const person = await pane({
      lineages: [
        lineage({ scopes: [scope(), { ...scope(), leaseId: 'lease-2', delegation: null }] }),
      ],
    });
    expect((person.find('[data-agent="scope"]') as HTMLElement | null)?.dataset['scope']).toBe(
      'person',
    );
    expect(person.find('[data-scope-part]')).toBeNull();
  });
});
