// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings General ▸ You and Notifications (MP-2-11; CS-2.8, CS-2.17). Every
// value here is the signed-in person's own, read with `preference.read` and
// written with `preference.save`, which reach the caller's own row and no one
// else's (the server's rule, tests/api/preferences.test.ts). Neither is
// audited (CS-2.8). A change is drawn at once and then saved; a refused save
// puts the server's words on the page and reads the store again.
//
// Notifications place INB-1's rule and store nothing: in-app is always on, the
// email choices wait for AW-07b's channel (drawn not connected, MP-1-6), and a
// decision or an incident is never silenced, which the server refuses too
// (`notifications.set_channel`, inbox-escalation-settings.test.ts).

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { NotConnected, Segmented, Switch } from '@launchastro/ui';
import { dismissedTipCount } from '../../../../../packages/core-wire/src/index.ts';
import { applyAppearance, isAppearance, type Appearance } from '../../appearance.ts';
import { isRefusal, type OperationsClient } from '../../operations/client.ts';
import { describeFailure, describeRefusal } from '../../records/submit.ts';
import type { StorageLike } from '../../session/token.ts';

type Preferences = Readonly<Record<string, unknown>>;

/** The label, one quiet sentence, and the control on the right (DS-COMP-13). */
function Row(props: {
  readonly id: string;
  readonly label: string;
  readonly sentence: ReactNode;
  readonly control?: ReactNode;
  readonly dataKey?: 'data-pref' | 'data-notify';
}): ReactElement {
  const key = { [props.dataKey ?? 'data-pref']: props.id };
  return (
    <div className="setrow" {...key}>
      <div className="setrow__text">
        <span className="setrow__k">{props.label}</span>
        <div className="card__sub">{props.sentence}</div>
      </div>
      {props.control === undefined ? null : <div className="setrow__control">{props.control}</div>}
    </div>
  );
}

/** The person's own preferences: read once per reader, changed at once, then saved. */
function usePreferences(client: OperationsClient, grantKey: string) {
  const [held, setHeld] = useState<{ readonly of: string; readonly value: Preferences } | null>(
    null,
  );
  const [because, setBecause] = useState<string | null>(null);

  const reread = useCallback(() => {
    let current = true;
    void client.read<{ readonly preferences?: unknown }>('preference.read', {}).then((answer) => {
      if (!current) return answer;
      const preferences = 'value' in answer ? answer.value.preferences : undefined;
      if (typeof preferences === 'object' && preferences !== null)
        setHeld({ of: grantKey, value: preferences as Preferences });
      else if (isRefusal(answer)) setBecause(describeRefusal(answer));
      else setBecause('Your preferences could not be read.');
      return answer;
    });
    return () => {
      current = false;
    };
  }, [client, grantKey]);

  useEffect(reread, [reread]);

  const save = (preference: string, value: unknown): void => {
    setHeld((before) => ({ of: grantKey, value: { ...before?.value, [preference]: value } }));
    setBecause(null);
    void client.mutate('preference.save', { preference, value }).then((result) => {
      const failed = describeFailure(result);
      if (failed !== null) {
        setBecause(failed);
        reread();
      }
      return result;
    });
  };

  const preferences = held !== null && held.of === grantKey ? held.value : null;
  return { preferences, because, save };
}

function AppearanceRow(props: {
  readonly appearance: Appearance;
  readonly choose: (value: Appearance) => void;
}): ReactElement {
  return (
    <Row
      id="appearance"
      label="Appearance"
      sentence="Light, Dark or System, on every device you sign in on."
      control={
        <Segmented
          label="Appearance"
          value={props.appearance}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'System' },
          ]}
          onChange={(value) => {
            if (isAppearance(value)) props.choose(value);
          }}
        />
      }
    />
  );
}

/** The tips switch, and the reset whose count is derived from the store (AG-X23). */
function TipsRows(props: {
  readonly preferences: Preferences | null;
  readonly save: (preference: string, value: unknown) => void;
}): ReactElement {
  const tipsOn = props.preferences?.['tips.enabled'] !== false;
  const dismissed = props.preferences === null ? 0 : dismissedTipCount(props.preferences);
  const closed = tipsOn
    ? dismissed === 0
      ? 'No tips are dismissed.'
      : null
    : 'Guided tips are off, so there is nothing to bring back.';
  return (
    <>
      <Row
        id="tips"
        label="Guided tips"
        sentence="Short tips on each page about what it is for."
        control={
          <Switch
            label="Guided tips"
            on={tipsOn}
            onChange={(on) => {
              props.save('tips.enabled', on);
            }}
          />
        }
      />
      <Row
        id="tips-reset"
        label="Dismissed tips"
        sentence={closed ?? 'Show every tip you dismissed again.'}
        control={
          <button
            className="btn"
            type="button"
            disabled={closed !== null}
            title={closed ?? undefined}
            onClick={() => {
              props.save('tips.dismissed', {});
            }}
          >
            {`Bring back ${String(dismissed)} dismissed ${dismissed === 1 ? 'tip' : 'tips'}`}
          </button>
        }
      />
    </>
  );
}

/** CS-2.17 as INB-1 rules it: nothing here is stored, so nothing here writes. */
function NotificationsGroup(): ReactElement {
  return (
    <section className="sb__sect" data-pref="notifications">
      <div className="sb__sh">
        <span className="sb__k">Notifications</span>
      </div>
      <Row
        id="in-app"
        dataKey="data-notify"
        label="In the app"
        sentence="Always on: every inbox item reaches you here."
        control={
          <Switch
            label="In-app notifications"
            on
            disabled
            reason="In-app is always on."
            onChange={() => {
              // In-app is always on: nothing to change.
            }}
          />
        }
      />
      <Row
        id="email"
        dataKey="data-notify"
        label="Email"
        sentence={
          <>
            Instant, Daily batch or Off, for each kind of inbox item.
            <NotConnected
              source="the email channel"
              reason="Email notifications arrive when the email channel is connected; until then only in-app reaches you."
            />
          </>
        }
      />
      <Row
        id="never-quiet"
        dataKey="data-notify"
        label="Decisions and Incidents"
        sentence="Decisions you are responsible for and Incidents are told at once on every channel: they cannot be silenced."
      />
    </section>
  );
}

export function YouGroups(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly storage: StorageLike | null;
}): ReactElement {
  const { preferences, because, save } = usePreferences(props.client, props.grantKey);
  const stored = preferences?.['appearance'];
  return (
    <>
      <section className="sb__sect" data-pref="you">
        <div className="sb__sh">
          <span className="sb__k">You</span>
        </div>
        {because === null ? null : (
          <p className="field__error" role="alert" data-pref="refusal">
            {because}
          </p>
        )}
        <AppearanceRow
          appearance={isAppearance(stored) ? stored : 'system'}
          choose={(value) => {
            applyAppearance(value, props.storage, true);
            save('appearance', value);
          }}
        />
        <TipsRows preferences={preferences} save={save} />
      </section>
      <NotificationsGroup />
    </>
  );
}
