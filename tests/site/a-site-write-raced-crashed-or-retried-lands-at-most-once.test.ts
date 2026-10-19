// SPDX-License-Identifier: AGPL-3.0-only
//
// `mergeAndFind` reads the default branch's head and then advances it to the
// proposal's head, a fast-forward only. Attacked on the provider double: two
// publishes that both read the base before either advances move the branch
// once, the second a no-op on the same head; a publish that dies after its read
// advances nothing, and the same request sent again lands once; and a request
// sent again after the provider applied it but its answer was lost sends
// nothing more. `revertForward` reads the site file and writes it naming the
// blob it read: two reverts that both read land one write, the other refused by
// the blob check; an edit between its read and write is never overwritten; and
// its crash and lost answer write once, as the publish's do.

import { describe, expect, it } from 'vitest';
import {
  mergeAndFind,
  revertForward,
  type BindingDependencies,
  type TransportAnswer,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';
import {
  AFTER,
  APPROVED,
  BEFORE,
  HEAD,
  SEAM,
  binding,
  proposed,
  type Provider,
} from './c80-site-provider.ts';

/** The read a write is decided on, and the write: the publish's head read and advance, the revert's file read and write. */
interface Step {
  readonly isRead: (request: TransportRequest) => boolean;
  readonly isWrite: (request: TransportRequest) => boolean;
}
const ADVANCE: Step = {
  isRead: (request) =>
    (request.method ?? 'GET') === 'GET' && request.url.pathname.endsWith('/git/ref/heads/main'),
  isWrite: (request) =>
    request.method === 'PATCH' && request.url.pathname.endsWith('/git/refs/heads/main'),
};
const CONTENTS: Step = {
  isRead: (request) =>
    (request.method ?? 'GET') === 'GET' && request.url.pathname.includes('/contents/'),
  isWrite: (request) => request.method === 'PUT' && request.url.pathname.includes('/contents/'),
};

const noop = (): void => undefined;

/** The advances the provider answered as applied. */
const applied = (answers: readonly TransportAnswer[]) =>
  answers.filter((answer) => answer.kind === 'answer' && answer.status === 200).length;

/**
 * Two publishes on one provider whose head reads are held until both have read,
 * so each advances from the base it read before the other advanced.
 */
function bothReadFirst(
  site: Provider,
  { isRead, isWrite }: Step,
): { deps: BindingDependencies; writes: TransportAnswer[] } {
  let open: () => void = noop;
  const bothRead = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reads = 0;
  const writes: TransportAnswer[] = [];
  return {
    writes,
    deps: {
      ...site.deps,
      transport: async (request) => {
        const answer = await site.deps.transport(request);
        if (isWrite(request)) writes.push(answer);
        if (isRead(request)) {
          reads += 1;
          if (reads === 2) open();
          await bothRead;
        }
        return answer;
      },
    },
  };
}

/** A provider that applies a write and then loses its answer, as a dropped connection does. */
function losesWriteAnswer(site: Provider, { isWrite }: Step): BindingDependencies {
  return {
    ...site.deps,
    transport: async (request) => {
      const answer = await site.deps.transport(request);
      return isWrite(request) ? { kind: 'timeout' } : answer;
    },
  };
}

/** A writer that dies after its read: its write never leaves. */
function diesAfterRead(site: Provider, { isWrite }: Step): BindingDependencies {
  return {
    ...site.deps,
    transport: async (request) => {
      if (isWrite(request)) throw new Error('the writer died after its read');
      return await site.deps.transport(request);
    },
  };
}

/** The provider after the approved publish: the file holds the published bytes. */
async function published(): Promise<Provider> {
  const site = proposed();
  expect(await mergeAndFind(binding, APPROVED, site.deps)).toMatchObject({ kind: 'ok' });
  site.sent.length = 0;
  return site;
}

const advances = (site: Provider) => site.sent.filter((sent) => sent.method === 'PATCH').length;
const puts = (site: Provider) => site.sent.filter((sent) => sent.method === 'PUT').length;

describe('a site publish raced, crashed or retried', () => {
  it('two publishes that both read the base before either advances move the branch once', async () => {
    const site = proposed();
    const { deps, writes } = bothReadFirst(site, ADVANCE);
    const answers = await Promise.all([
      mergeAndFind(binding, APPROVED, deps),
      mergeAndFind(binding, APPROVED, deps),
    ]);
    // Both name the one approved head: the second finds the branch already there, a no-op.
    expect(answers.map((answer) => answer.kind)).toEqual(['ok', 'ok']);
    expect(applied(writes)).toBe(2);
    expect(site.sent.filter((sent) => sent.method === 'PATCH').map((sent) => sent.body)).toEqual([
      { sha: HEAD },
      { sha: HEAD },
    ]);
    expect(site.state.mainHead).toBe(HEAD);
    expect(site.state.parents[HEAD]).toBe('base-commit');
    expect(site.state.content).toBe(AFTER);
    expect(Object.keys(site.state.deployments)).toHaveLength(1);
  });

  it('a publish that dies after its read advances nothing, and sent again lands once', async () => {
    const site = proposed();
    await expect(mergeAndFind(binding, APPROVED, diesAfterRead(site, ADVANCE))).rejects.toThrow();
    expect(site.state.content).toBe(BEFORE);
    expect(advances(site)).toBe(0);
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toMatchObject({ kind: 'ok' });
    expect(site.state.content).toBe(AFTER);
    expect(advances(site)).toBe(1);
  });

  it('a publish sent again after the provider applied it and its answer was lost sends nothing more', async () => {
    const site = proposed();
    const lost = await mergeAndFind(binding, APPROVED, losesWriteAnswer(site, ADVANCE));
    expect(lost.kind).toBe('unknown');
    expect(site.state.content).toBe(AFTER);
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
      kind: 'refused',
      code: 'CONTENT_DRIFTED',
    });
    expect(site.state.content).toBe(AFTER);
    expect(advances(site)).toBe(1);
  });
});

// eslint-disable-next-line max-lines-per-function -- the revert's race, crash and retry cases
describe('a site revert raced, crashed or retried', () => {
  it('two reverts that both read before either writes land one write, the other refused by the blob check', async () => {
    const site = await published();
    const { deps, writes } = bothReadFirst(site, CONTENTS);
    const answers = await Promise.all([
      revertForward(binding, { seam: SEAM }, deps),
      revertForward(binding, { seam: SEAM }, deps),
    ]);
    expect(answers.map((answer) => answer.kind).toSorted()).toEqual(['ok', 'refused']);
    expect(answers.find((answer) => answer.kind === 'refused')).toMatchObject({
      code: 'PROVIDER_REFUSED',
      proof: 'sha_mismatch',
    });
    expect(applied(writes)).toBe(1);
    expect(site.state.content).toBe(BEFORE);
  });

  it('an edit landing between the revert read and its write is never overwritten', async () => {
    const site = await published();
    const edited = `${AFTER}<p>An edit made meanwhile.</p>\n`;
    const deps: BindingDependencies = {
      ...site.deps,
      transport: async (request) => {
        if (CONTENTS.isWrite(request)) {
          site.state.content = edited;
          site.state.blob = 'blob-edited';
        }
        return await site.deps.transport(request);
      },
    };
    expect(await revertForward(binding, { seam: SEAM }, deps)).toEqual({
      kind: 'refused',
      code: 'PROVIDER_REFUSED',
      proof: 'sha_mismatch',
    });
    expect(site.state.content).toBe(edited);
  });

  it('a revert whose writer dies after its read writes nothing, and sent again lands once', async () => {
    const site = await published();
    await expect(
      revertForward(binding, { seam: SEAM }, diesAfterRead(site, CONTENTS)),
    ).rejects.toThrow();
    expect(site.state.content).toBe(AFTER);
    expect(await revertForward(binding, { seam: SEAM }, site.deps)).toMatchObject({ kind: 'ok' });
    expect(site.state.content).toBe(BEFORE);
    expect(puts(site)).toBe(1);
  });

  it('a revert sent again after the provider applied it and its answer was lost writes nothing more', async () => {
    const site = await published();
    const lost = await revertForward(binding, { seam: SEAM }, losesWriteAnswer(site, CONTENTS));
    expect(lost.kind).toBe('unknown');
    expect(site.state.content).toBe(BEFORE);
    expect(await revertForward(binding, { seam: SEAM }, site.deps)).toEqual({
      kind: 'refused',
      code: 'CONTENT_DRIFTED',
    });
    expect(site.state.content).toBe(BEFORE);
    expect(puts(site)).toBe(1);
  });
});
