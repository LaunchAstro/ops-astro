// SPDX-License-Identifier: AGPL-3.0-only
//
// Artefacts and evidence (MP-6-2, TA-05): "Checks passed" as two different
// counts, the checks that passed out of the checks the run recorded, never one
// count twice. The artefact rows and their supersedes chain wait on an
// artefact store; the checks are the run's own (run_checks).

import type { ReactElement } from 'react';
import { PaneEmpty } from '../../primitives/Absence.tsx';
import type { RunStory } from '../../state/agent-run.ts';

export function Evidence(props: { readonly story: RunStory }): ReactElement {
  const { checks } = props.story;
  // The Summary's progress counts the same way (agent-run.ts).
  const passed = checks.filter((check) => check.outcome === 'passed').length;
  return (
    <section data-agent="evidence">
      <div className="sb__sh">
        <span className="sb__k">Artefacts and evidence</span>
      </div>
      {checks.length === 0 ? (
        <PaneEmpty say="No checks recorded yet." />
      ) : (
        <div className="sout__box">
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
        </div>
      )}
    </section>
  );
}
