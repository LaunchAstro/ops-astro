// SPDX-License-Identifier: AGPL-3.0-only
//
// Artefacts and evidence (MP-6-2, TA-05). The artefact is the proposal the run
// staged, titled by its purpose; its versions are the lineage's, newest first,
// each "vN · current" while nothing supersedes it, its short digest,
// "supersedes vN" for the version before it, and the checks recorded on it as
// its evidence bullets. "Checks passed" is two different counts, the head's
// checks that passed out of those it recorded, never one count twice.

import type { ReactElement } from 'react';
import { Empty } from '../../primitives/Absence.tsx';
import type { RunStory } from '../../state/agent-run.ts';
import type { RunVersion } from '../../state/run-projection.ts';
import { shortDigest, words } from './format.ts';

function VersionRow(props: {
  readonly version: RunVersion;
  readonly before: RunVersion | undefined;
}): ReactElement {
  const { version, before } = props;
  return (
    <div className="sout__row" data-evidence="version">
      <span className="tf__k">
        v{version.version}
        {version.supersededAt === null ? ' · current' : ''}
      </span>
      <span className="sbact__meta u-mono" title={version.payloadDigest}>
        {shortDigest(version.payloadDigest)}
        {before === undefined ? '' : ` · supersedes v${String(before.version)}`}
      </span>
      {version.checks.length > 0 && (
        <div className="md">
          <ul>
            {version.checks.map((check) => (
              <li key={check.id}>
                {check.name} <span className="sbact__meta u-mono">{check.outcome}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** `versions` are the lineage's, newest first: the head and what it superseded. */
export function Evidence(props: {
  readonly story: RunStory;
  readonly versions: readonly RunVersion[];
}): ReactElement {
  const { checks, head } = props.story;
  const { versions } = props;
  // The Summary's progress counts the same way (agent-run.ts).
  const passed = checks.filter((check) => check.outcome === 'passed').length;
  return (
    <section data-agent="evidence">
      <div className="sb__sh">
        <span className="sb__k">Artefacts and evidence</span>
      </div>
      <div className="sout__box">
        <div className="sout__row" data-evidence="artefact">
          <span className="tf__k">Proposal</span>
          <span className="sout__t">{words(head.purpose)}</span>
        </div>
        {checks.length === 0 ? (
          <Empty look="inline" title="No checks recorded yet." />
        ) : (
          <div className="sout__row" data-evidence="checks">
            <span className="tf__k">Checks passed</span>
            <span>
              <span className="tokrun__n" data-evidence="passed">
                {passed}
              </span>{' '}
              <span className="tokrun__k" data-evidence="recorded">
                of {checks.length} recorded
              </span>
            </span>
          </div>
        )}
        {versions.map((version, index) => (
          <VersionRow key={version.versionId} version={version} before={versions[index + 1]} />
        ))}
      </div>
    </section>
  );
}
