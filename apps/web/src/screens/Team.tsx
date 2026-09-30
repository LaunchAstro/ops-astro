// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel (MP-7-10) on its route: the kit's one TeamPanel, fed by
// `team.list` and saving the person's own availability (CS-7.27) through
// `account/availability`. The strip is `team.list`, staff only, and a client
// is answered NOT_FOUND by the server, so this screen never decides who is
// staff. It draws nothing of its own but a refused save.
//
// Two of the panel's parts are withheld until what they stand on exists: the
// conversations (C71-D direct, C71-G group), whose comment read and command
// are MP-4-5's, and a teammate's name as the door to their work, which needs
// a view of a person's work. Until then the names are plain and the
// conversation room is empty.

import { useState, type ReactElement } from 'react';
import { TeamPanel, type AvailabilityChange, type Teammate } from '@launchastro/ui';
import type { TeamListResult, TeamMemberView } from '../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../operations/client.ts';
import { useRead } from '../data/use-read.ts';
import { RecordState } from '../views/record-state.tsx';
import { describeRefusal } from '../records/submit.ts';

/** A member as the panel draws them: the first name under the face, up to two initials on it. */
function teammate(member: TeamMemberView): Teammate {
  const words = member.name.split(/\s+/u).filter((word) => word !== '');
  return {
    personId: member.personId,
    name: member.name,
    short: words[0] ?? member.name,
    initials: words
      .slice(0, 2)
      .map((word) => word.slice(0, 1).toUpperCase())
      .join(''),
    away: member.availability?.state === 'away' ? { reason: member.availability.reason } : null,
  };
}

/** What the panel asks for, as the command's body: away carries the reason, available carries none. */
const bodyOf = (change: AvailabilityChange): Readonly<Record<string, unknown>> =>
  change.away ? { state: 'away', reason: change.reason } : { state: 'available' };

export function TeamScreen(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
}): ReactElement {
  const { client } = props;
  const { state, reload } = useRead<TeamListResult>({
    grantKey: props.grantKey,
    run: () => client.read<TeamListResult>('team.list', {}),
    isEmpty: (value) => value.people.length === 0,
    deps: [],
  });
  const [because, setBecause] = useState<string | null>(null);

  const onSetAvailability = (change: AvailabilityChange): void => {
    setBecause(null);
    void (async () => {
      const result = await client.setAvailability(bodyOf(change));
      if (isRefusal(result)) setBecause(describeRefusal(result));
      else if (isUnavailable(result)) setBecause(result.because);
      else reload();
    })();
  };

  return (
    <div className="stack">
      <RecordState state={state} subject="team" onRetry={reload}>
        {(value) => (
          <TeamPanel
            people={value.people.map(teammate)}
            me={value.you}
            onSetAvailability={onSetAvailability}
            work={null}
            conversations={null}
          />
        )}
      </RecordState>
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </div>
  );
}
