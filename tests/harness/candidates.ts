// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: the harness candidates, pinned as recorded data.
//
// The candidates are the ones the decision names (roadmap docs/decisions.md,
// "Harness adoption"): Deep Agents 1.13.4, LangGraph 1.4.14 with its Postgres
// checkpointer 1.0.5 entered separately, and Langflow v1.12.1, each pinned to
// the commit its release tag resolves to, with the licence read from the
// LICENSE file at that commit. The identities are the ones the test's own
// lane read from each candidate's repository (roadmap
// research/harness-test-2026-09-11/sources.json, `external_primary_sources`,
// retrieved 11 September 2026). Nothing here is fetched, installed or run:
// a candidate never enters the product's dependency tree (`AW-12 candidate
// audit`), and nothing here adopts one.
//
// `pinOf` is the pinning rule (TEST.md 3.3): an exact release tag and the
// commit it resolves to, and every licence read at that commit. A version
// range, `latest`, a short commit or a licence read anywhere else is not a pin.

export type Entry = 'H1' | 'H2' | 'H2b' | 'H3' | 'H1/H2 dep';

export interface LicenceRead {
  /** The licence file's path in the candidate's tree. */
  readonly path: string;
  readonly spdx: string;
  /** The file's address at the pinned commit. */
  readonly url: string;
}

export interface CandidateRecord {
  readonly entry: Entry;
  /** The packages the entry would bring, as their registries name them. */
  readonly packages: readonly string[];
  readonly repository: string;
  readonly tag: string;
  readonly version: string;
  readonly commit: string;
  readonly licences: readonly LicenceRead[];
  /** What the licence reading did not establish, carried and never dropped. */
  readonly unread: readonly string[];
  readonly runtime: 'node' | 'python';
  /** The persistence it brings, priced later (TEST.md 7.3). */
  readonly persistence: string;
  /** Entries it cannot be adopted without. */
  readonly requires: readonly Entry[];
}

const licence = (repository: string, commit: string, spdx: string): LicenceRead => ({
  path: 'LICENSE',
  spdx,
  url: `${repository}/blob/${commit}/LICENSE`,
});

const DEEPAGENTS = 'https://github.com/langchain-ai/deepagentsjs';
const LANGGRAPH = 'https://github.com/langchain-ai/langgraphjs';
const LANGCHAIN = 'https://github.com/langchain-ai/langchainjs';
const LANGFLOW = 'https://github.com/langflow-ai/langflow';

const TREE_UNREAD =
  'the transitive dependency tree and its licences (TEST.md 3.3 rule 4): read at the pin when the round runs';

export const CANDIDATES: readonly CandidateRecord[] = [
  {
    entry: 'H1',
    packages: ['deepagents'],
    repository: DEEPAGENTS,
    tag: 'deepagents@1.13.4',
    version: '1.13.4',
    commit: 'daf3f99c23d24964246e749173dd0427e174643a',
    licences: [licence(DEEPAGENTS, 'daf3f99c23d24964246e749173dd0427e174643a', 'MIT')],
    unread: [TREE_UNREAD],
    runtime: 'node',
    persistence: 'none of its own; its virtual filesystem is in-process unless given a backend',
    requires: ['H2', 'H1/H2 dep'],
  },
  {
    entry: 'H2',
    packages: ['@langchain/langgraph'],
    repository: LANGGRAPH,
    tag: '@langchain/langgraph@1.4.14',
    version: '1.4.14',
    commit: '9ae75600dd84d6b2bc736e33baaf66a556d61c49',
    licences: [licence(LANGGRAPH, '9ae75600dd84d6b2bc736e33baaf66a556d61c49', 'MIT')],
    unread: [TREE_UNREAD],
    runtime: 'node',
    persistence: 'none in the core package',
    requires: ['H1/H2 dep'],
  },
  {
    entry: 'H2b',
    packages: ['@langchain/langgraph-checkpoint-postgres'],
    repository: LANGGRAPH,
    tag: '@langchain/langgraph-checkpoint-postgres@1.0.5',
    version: '1.0.5',
    commit: '6530ba9b4c577c560422d9c9de18914e67411d9d',
    licences: [licence(LANGGRAPH, '6530ba9b4c577c560422d9c9de18914e67411d9d', 'MIT')],
    unread: [TREE_UNREAD],
    runtime: 'node',
    persistence:
      'four tables it creates itself: checkpoint_migrations, checkpoints, checkpoint_blobs, checkpoint_writes',
    requires: ['H2'],
  },
  {
    entry: 'H3',
    packages: ['langflow', 'lfx'],
    repository: LANGFLOW,
    tag: 'v1.12.1',
    version: '1.12.1',
    commit: 'a397dc3a8ef37843411921ffd2c1276b9eb9ffbf',
    licences: [licence(LANGFLOW, 'a397dc3a8ef37843411921ffd2c1276b9eb9ffbf', 'MIT')],
    unread: [
      TREE_UNREAD,
      'one workspace package declared Apache-2.0 at the older reviewed revision; not re-read at this pin',
    ],
    runtime: 'python',
    persistence: 'the server ships its own database and migration history',
    requires: [],
  },
  {
    entry: 'H1/H2 dep',
    packages: ['langchain', '@langchain/core'],
    repository: LANGCHAIN,
    tag: 'langchain@1.5.11',
    version: '1.5.11',
    commit: 'a443ab0c6e20a1684ce2493ba859d25e962009bd',
    licences: [licence(LANGCHAIN, 'a443ab0c6e20a1684ce2493ba859d25e962009bd', 'MIT')],
    unread: [TREE_UNREAD],
    runtime: 'node',
    persistence: 'none',
    requires: [],
  },
];

export type PinFault =
  'repository' | 'tag' | 'version' | 'commit' | 'licence missing' | 'licence not read at the pin';

const COMMIT = /^[0-9a-f]{40}$/u;
const EXACT = /^\d+\.\d+\.\d+$/u;
const REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** Every pinning rule the record breaks, or none. */
export function pinFaults(record: CandidateRecord): readonly PinFault[] {
  const faults: PinFault[] = [];
  if (!REPOSITORY.test(record.repository)) faults.push('repository');
  if (!EXACT.test(record.version)) faults.push('version');
  if (record.tag !== `v${record.version}` && !record.tag.endsWith(`@${record.version}`)) {
    faults.push('tag');
  }
  if (!COMMIT.test(record.commit)) faults.push('commit');
  if (record.licences.length === 0) faults.push('licence missing');
  const at = `${record.repository}/blob/${record.commit}/`;
  if (record.licences.some((read) => read.url !== `${at}${read.path}` || read.spdx.trim() === '')) {
    faults.push('licence not read at the pin');
  }
  return faults;
}

/** The recorded licences as a `pnpm licenses list --json` report, for the product's own checker. */
export function licenceReport(
  records: readonly CandidateRecord[],
): Record<string, { name: string; version: string }[]> {
  const report: Record<string, { name: string; version: string }[]> = {};
  for (const record of records) {
    for (const read of record.licences) {
      for (const name of record.packages) {
        (report[read.spdx] ??= []).push({ name, version: record.version });
      }
    }
  }
  return report;
}
