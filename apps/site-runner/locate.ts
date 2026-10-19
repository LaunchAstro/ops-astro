// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's locate (#1693): each pass takes the configured site's
// holder's due corrections in turn (`dueCorrections`, 20 at most) and checks
// each against the file at the default branch's head, read through custody.
// Another holder's corrections are left for its own runner.
//
// - Before any provider call, a correction bound to any site but the
//   configured one is refused: a `locating` one settles `unlocated
//   SITE_NOT_CONFIGURED`, a `requested` one is put behind the rest with nothing
//   stamped. A page and file that are not one configured pair settle `unlocated
//   NOT_FOUND`.
// - Then one head read for the pass, and one read of each due path at that
//   commit: 1 + P provider calls, however many corrections share a path.
// - A `locating` correction is pinned from the file it read: the phrase
//   change made here at the place the envelope holds (`replaced`), its
//   digests computed one way (`versionDigestOf`). A `requested` one is
//   stamped while its file still holds the pinned bytes, else superseded.
// - A head or file read that fails backs its corrections off (`checksFailed`),
//   and healthy paths go on. An answer not in the provider's own shape (a
//   field missing or of another type, a body that is not JSON, a commit or
//   blob that is not a hash, content that is not canonical base64) settles a
//   `locating` correction `unlocated PROVIDER_RESPONSE_MALFORMED` and counts as
//   a failure for a `requested` one.
// Each correction's write is its own transaction, never held across a call.
// What is logged is the correction's id and a code, never a word, path,
// content, token or address.

import { randomUUID } from 'node:crypto';
import {
  checkEnvelope,
  contentDigest,
  replaced,
  versionDigestOf,
  type ProviderResult,
  type ProviderValue,
} from '../../packages/core-connectors/src/index.ts';
import type { BusinessId, Database, TenantQuery } from '../../packages/core-records/src/index.ts';
import {
  checkLater,
  checksFailed,
  dueCorrections,
  pinLocated,
  stampVerified,
  supersede,
  unlocate,
  type ConfiguredSite,
  type DueCorrection,
} from '../../packages/core-records/src/site/locate.ts';
import { bindingConfigured, NOT_CONFIGURED, pairConfigured } from './configured.ts';
import type { Passed } from './runner.ts';
import type { LocatePorts } from './sites.ts';

export const MALFORMED = 'PROVIDER_RESPONSE_MALFORMED';

export interface LocateDeps {
  readonly db: Database;
  readonly business: BusinessId;
  readonly site: ConfiguredSite;
  readonly ports: LocatePorts;
}

/** A commit or blob as the provider names it: 40 or 64 lowercase hex. */
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * The text a provider's base64 encodes, line breaks aside, or undefined unless it is the
 * canonical encoding of valid UTF-8: decoding and encoding again gives back exactly what was sent.
 */
function decoded(base64: string): string | undefined {
  const joined = base64.split('\n').join('');
  const bytes = Buffer.from(joined, 'base64');
  if (bytes.toString('base64') !== joined) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

type Read<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'failed' }
  | { readonly kind: 'malformed' };

const MALFORMED_READ = { kind: 'malformed' } as const;
const FAILED_READ = { kind: 'failed' } as const;

/** The guarded call's codes for an answer it got but could not take: a field off schema, or no JSON. */
const OUT_OF_SHAPE: ReadonlySet<string> = new Set(['PROVIDER_RESPONSE_SCHEMA', MALFORMED]);

/** A read with no value: malformed when the provider answered out of shape, else failed. */
const unread = (read: ProviderResult<ProviderValue>) =>
  read.kind === 'refused' && OUT_OF_SHAPE.has(read.code) ? MALFORMED_READ : FAILED_READ;

const headFrom = (read: ProviderResult<ProviderValue>): Read<string> => {
  if (read.kind !== 'ok') return unread(read);
  const sha = read.value['object.sha'];
  return typeof sha === 'string' && HASH.test(sha) ? { kind: 'ok', value: sha } : MALFORMED_READ;
};

const fileFrom = (read: ProviderResult<ProviderValue>): Read<string> => {
  if (read.kind !== 'ok') return unread(read);
  const { sha, encoding, content } = read.value;
  if (typeof sha !== 'string' || !HASH.test(sha) || encoding !== 'base64') return MALFORMED_READ;
  const text = typeof content === 'string' ? decoded(content) : undefined;
  return text === undefined ? MALFORMED_READ : { kind: 'ok', value: text };
};

interface Locate {
  readonly deps: LocateDeps;
  readonly passed: Passed[];
}

const inBusiness = async <T>({ deps }: Locate, work: (tx: TenantQuery) => Promise<T>) =>
  await deps.db.withBusiness(deps.business, work);

const note = ({ passed }: Locate, correctionId: string, outcome: string): void => {
  passed.push({ correctionId, outcome });
};

/** Settled `unlocated` with its code while still locating. */
async function unlocated(locate: Locate, id: string, code: string): Promise<void> {
  if (await inBusiness(locate, async (tx) => await unlocate(tx, id, code))) note(locate, id, code);
}

/** Refused before any call: a `locating` one settles, a `requested` one waits its turn unstamped. */
async function refuse(locate: Locate, due: DueCorrection, code: string): Promise<void> {
  if (due.state === 'locating') {
    await unlocated(locate, due.id, code);
    return;
  }
  await inBusiness(locate, async (tx) => await checkLater(tx, [due.id]));
  note(locate, due.id, NOT_CONFIGURED);
}

/** The provider failed these corrections: each backs off, an aged `locating` one settles. */
async function failed(locate: Locate, dues: readonly DueCorrection[]): Promise<void> {
  if (dues.length === 0) return;
  const ids = dues.map((due) => due.id);
  const settled = await inBusiness(locate, async (tx) => await checksFailed(tx, ids));
  for (const id of ids)
    note(locate, id, settled.includes(id) ? 'SITE_UNREACHABLE' : 'CHECK_FAILED');
}

/** An answer not in the provider's shape: `locating` ones settle, `requested` ones count it a failure. */
async function malformed(locate: Locate, dues: readonly DueCorrection[]): Promise<void> {
  for (const due of dues.filter((each) => each.state === 'locating')) {
    // oxlint-disable-next-line no-await-in-loop -- one write each, in turn
    await unlocated(locate, due.id, MALFORMED);
  }
  await failed(
    locate,
    dues.filter((each) => each.state === 'requested'),
  );
}

/** A `locating` correction pinned from the file at `head`, or settled with the reason it cannot be. */
async function pin(locate: Locate, due: DueCorrection, content: string, head: string) {
  const path = due.targetPath;
  const after = replaced(path, content, due.word, due.replacement);
  if (after === null) return await unlocated(locate, due.id, 'WORD_NOT_FOUND');
  const target = { path, word: due.word, replacement: due.replacement };
  const change = { files: [{ path, before: content, after }] };
  if (!checkEnvelope(change, target).ok)
    return await unlocated(locate, due.id, 'CHANGE_ENVELOPE_EXCEEDED');
  const preImageDigest = contentDigest(content);
  const { pageUrl, seam } = due;
  const pinned = {
    id: due.id,
    versionId: randomUUID(),
    baseRevision: head,
    preImageDigest,
    versionDigest: versionDigestOf({
      target,
      change,
      preImageDigest,
      baseRevision: head,
      pageUrl,
      seam,
    }),
  };
  const { site } = locate.deps;
  const outcome = await inBusiness(locate, async (tx) => await pinLocated(tx, site, pinned));
  if (outcome === 'pinned') note(locate, due.id, 'requested');
  if (outcome === 'unlocated') note(locate, due.id, 'SITE_CHANGED');
}

/** A `requested` correction stamped while its file holds the pinned bytes, else superseded. */
async function check(locate: Locate, due: DueCorrection, content: string): Promise<void> {
  const digest = contentDigest(content);
  const { site } = locate.deps;
  if (digest === due.preImageDigest) {
    await inBusiness(locate, async (tx) => await stampVerified(tx, site, due.id, digest));
    return;
  }
  if (await inBusiness(locate, async (tx) => await supersede(tx, site, due.id, digest)))
    note(locate, due.id, 'CONTENT_DRIFTED');
}

/** The due corrections the configured site holds, each refused that it does not. */
async function admitted(locate: Locate): Promise<DueCorrection[]> {
  const { site } = locate.deps;
  const due = await inBusiness(locate, async (tx) => await dueCorrections(tx, site.holder));
  const checking: DueCorrection[] = [];
  for (const each of due) {
    if (!bindingConfigured(site, each.holder, each.site)) {
      // oxlint-disable-next-line no-await-in-loop -- one write each, in turn
      await refuse(locate, each, NOT_CONFIGURED);
    } else if (pairConfigured(site, each.pageUrl, each.targetPath)) checking.push(each);
    // oxlint-disable-next-line no-await-in-loop
    else await refuse(locate, each, 'NOT_FOUND');
  }
  return checking;
}

/** One pass of the locate: what it settled or put off, by correction id and code. */
export async function locatePass(deps: LocateDeps): Promise<readonly Passed[]> {
  const locate: Locate = { deps, passed: [] };
  const checking = await admitted(locate);
  if (checking.length === 0) return locate.passed;
  const head = headFrom(await deps.ports.head());
  if (head.kind === 'failed') await failed(locate, checking);
  if (head.kind === 'malformed') await malformed(locate, checking);
  if (head.kind !== 'ok') return locate.passed;
  const byPath = new Map<string, DueCorrection[]>();
  for (const due of checking)
    byPath.set(due.targetPath, [...(byPath.get(due.targetPath) ?? []), due]);
  for (const [path, dues] of byPath) {
    // oxlint-disable-next-line no-await-in-loop -- one read per path, in turn
    const file = fileFrom(await deps.ports.file(path, head.value));
    if (file.kind !== 'ok') {
      // oxlint-disable-next-line no-await-in-loop
      await (file.kind === 'failed' ? failed(locate, dues) : malformed(locate, dues));
      continue;
    }
    for (const due of dues) {
      // oxlint-disable-next-line no-await-in-loop -- one write each, in turn
      await (due.state === 'locating'
        ? pin(locate, due, file.value, head.value)
        : check(locate, due, file.value));
    }
  }
  return locate.passed;
}
