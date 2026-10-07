// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { type ReadAuditNote } from '../../packages/core-runtime/src/index.ts';
import { ENTRY, FILES, fingerprint, readAs, sourceOf } from './aw-02-world.ts';
import { noDatabase, useReferences, s, own, other } from './run-side-reference-fixture.ts';

useReferences();
describe.skipIf(noDatabase)('a pinned read stays with its run', () => {
  it('refuses another run step without returning bytes or recording the read', async () => {
    const notes: ReadAuditNote[] = [];
    const before = await fingerprint(s);
    await expect(
      readAs(
        s,
        {
          leaseId: own.lease_id,
          holderActorId: s.agentActorId,
          runId: own.run_id,
          stepId: other.step_id,
          path: ENTRY,
        },
        notes,
        sourceOf(FILES),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    expect(notes).toEqual([]);
    expect(await fingerprint(s)).toEqual(before);
  });
  it('returns the pinned bytes for its own run step', async () => {
    const notes: ReadAuditNote[] = [];
    await expect(
      readAs(
        s,
        {
          leaseId: own.lease_id,
          holderActorId: s.agentActorId,
          runId: own.run_id,
          stepId: own.step_id,
          path: ENTRY,
        },
        notes,
        sourceOf(FILES),
      ),
    ).resolves.toBe('read');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.runId).toBe(own.run_id);
  });
});
