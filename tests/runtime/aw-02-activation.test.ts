// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-02 without a database: a file's identity, the set digest, the manifest,
// and the refusal of every activation that is not a person's manual act. The
// refusal is the first thing an activation meets, so it answers before any
// run row can exist. A pure unit suite: not named for the database gate.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  admitActivation,
  captureManifest,
  identityOf,
  setDigest,
  type Activator,
} from '../../packages/core-runtime/src/index.ts';
import type { InstructionSource } from '../../packages/core-runtime/src/index.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const ENTRY = 'skills/brief/SKILL.md';
const FRAGMENT = 'skills/shared/preamble.md';
const FILES = new Map([
  [ENTRY, encode('# Brief\nWrite the brief.\n')],
  [FRAGMENT, encode('Plain words.\n')],
]);
const source: InstructionSource = { read: async (path) => await Promise.resolve(FILES.get(path)) };

const PERSON: Activator = { kind: 'person', actorId: randomUUID() };
const SYSTEM: Activator = { kind: 'system', actorId: null };
const AGENT: Activator = { kind: 'agent', actorId: randomUUID() };

/** Each asked activation and the code it must be refused with. */
const REFUSED: readonly (readonly [string, Activator, string])[] = [
  ['schedule', SYSTEM, 'ACTIVATION_MODE_NOT_PERMITTED'],
  ['event', SYSTEM, 'ACTIVATION_MODE_NOT_PERMITTED'],
  ['timer', SYSTEM, 'ACTIVATION_MODE_NOT_PERMITTED'],
  // A person naming an unattended mode is refused as firmly as the system.
  ['schedule', PERSON, 'ACTIVATION_MODE_NOT_PERMITTED'],
  ['event', PERSON, 'ACTIVATION_MODE_NOT_PERMITTED'],
  ['timer', PERSON, 'ACTIVATION_MODE_NOT_PERMITTED'],
  // Manual is a person's act: the system cannot claim it.
  ['manual', SYSTEM, 'ACTIVATION_MODE_NOT_PERMITTED'],
  // Hostile spellings of manual are not manual.
  ['Manual', PERSON, 'ACTIVATION_MODE_NOT_PERMITTED'],
  [' manual', PERSON, 'ACTIVATION_MODE_NOT_PERMITTED'],
  ['manual\t', PERSON, 'ACTIVATION_MODE_NOT_PERMITTED'],
  ['MANUAL', PERSON, 'ACTIVATION_MODE_NOT_PERMITTED'],
  ['', PERSON, 'ACTIVATION_MODE_NOT_PERMITTED'],
  // A person with no actor is nobody.
  ['manual', { kind: 'person', actorId: null }, 'ACTIVATION_MODE_NOT_PERMITTED'],
  // An agent is refused whatever mode it names.
  ['manual', AGENT, 'DELEGATION_EXCLUDES_ACTIVATION'],
  ['schedule', AGENT, 'DELEGATION_EXCLUDES_ACTIVATION'],
];

const answerTo = (mode: string, activator: Activator): string => {
  const answer = admitActivation({ mode, activator });
  return answer.ok ? 'admitted' : answer.refusal.code;
};

async function refusedPath(path: string): Promise<string> {
  const refused = await captureManifest(source, [path]);
  return refused.ok ? 'ok' : refused.refusal.code;
}

describe('AW-02 file identity (no database)', () => {
  it('identity is digest and size; the path is provenance only', () => {
    const bytes = encode('same bytes');
    const here = identityOf('a/one.md', bytes);
    const there = identityOf('b/two.md', bytes);
    expect([here.digest, here.size]).toStrictEqual([there.digest, there.size]);
    const changed = identityOf('a/one.md', encode('same bytes!'));
    expect(changed.digest).not.toBe(here.digest);
  });

  it('the set digest is path-sorted, de-duplicated and blind to read order', () => {
    const a = identityOf('a.md', encode('a'));
    const b = identityOf('b.md', encode('b'));
    const once = setDigest([b, a]);
    expect(setDigest([a, b, a, b])).toStrictEqual(once);
    expect(once.count).toBe(2);
    expect(setDigest([a]).digest).not.toBe(once.digest);
  });

  it('the manifest is captured sorted by path, and an unreadable or odd path refuses', async () => {
    const captured = await captureManifest(source, [FRAGMENT, ENTRY, ENTRY]);
    if (!captured.ok) throw new Error('manifest refused');
    expect(captured.value.entries.map((entry) => entry.path)).toStrictEqual([ENTRY, FRAGMENT]);
    const bad = ['skills/missing.md', '../etc/passwd', '/abs.md', 'a//b.md', 'a/./b.md'];
    const answers = await Promise.all(bad.map(async (path) => await refusedPath(path)));
    expect(answers).toStrictEqual(bad.map(() => 'DEFINITION_UNAVAILABLE'));
  });
});

it('AW-02 no scheduled activation: a schedule, event or timer naming a file is refused before any run exists', () => {
  for (const [mode, activator, code] of REFUSED) {
    expect(answerTo(mode, activator), `${activator.kind} ${JSON.stringify(mode)}`).toBe(code);
  }
  // The one admitted shape, which is what `pinBootstrapFile` requires.
  const admitted = admitActivation({ mode: 'manual', activator: PERSON });
  expect(admitted.ok && admitted.value.actorId).toBe(PERSON.actorId);
});
