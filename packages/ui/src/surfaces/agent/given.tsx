// SPDX-License-Identifier: AGPL-3.0-only
//
// What the run was given (MP-6-2, TA-09, CS-6.7): the run's pins as
// `task.read` carries them, each with its kind, its label and "pinned at run
// start", and a note ending with the short digest. The labels are plain text:
// no screen opens an instruction file at a digest yet. A version with no run
// has no section.

import type { ReactElement } from 'react';
import { Empty } from '../../primitives/Absence.tsx';
import type { RunPin, RunVersion } from '../../state/run-projection.ts';
import { shortDigest, words } from './format.ts';

const KINDS: Readonly<Record<string, string>> = {
  bootstrap_file: 'Skill file',
  definition_version: 'Definition version',
};

export function Given(props: { readonly head: RunVersion }): ReactElement | null {
  if (props.head.runId === null) return null;
  const pins = props.head.pins ?? [];
  return (
    <section data-agent="given">
      <div className="sb__sh">
        <span className="sb__k">What the run was given</span>
        <span className="sbact__meta">context snapshot</span>
      </div>
      {pins.length === 0 ? (
        <Empty look="inline" title="Nothing was pinned for this run." />
      ) : (
        <>
          <div className="sout__box">
            {pins.map((pin) => (
              <PinRow key={`${pin.kind}:${pin.digest}`} pin={pin} />
            ))}
          </div>
          <p className="sbact__meta" data-given="note">
            Pinned when the run began and not changed since, so its evidence can be checked against
            it.{' '}
            <span className="u-mono">{pins.map((pin) => shortDigest(pin.digest)).join(' · ')}</span>
          </p>
        </>
      )}
    </section>
  );
}

function PinRow(props: { readonly pin: RunPin }): ReactElement {
  const { pin } = props;
  return (
    <div className="sout__row" data-given="pin" data-given-kind={pin.kind}>
      <span className="tf__k">{KINDS[pin.kind] ?? words(pin.kind)}</span>
      <span className="sout__v" data-given="label">
        {pin.path ?? pin.definitionVersionId ?? ''}
      </span>
      <span className="sbact__meta">pinned at run start</span>
    </div>
  );
}
