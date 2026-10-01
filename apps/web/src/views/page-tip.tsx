// SPDX-License-Identifier: AGPL-3.0-only
//
// A section tip on a built page (MP-9-1): the page kit's SectionTip, fed by
// the one preference store. The person's `tips.dismissed` and `tips.enabled`
// come from `preference.read`; a dismissal is `preference.dismiss_tip` with
// the tip's page, id and version, sent once. Nothing is kept in the browser.
//
// Until the store answers, and when it cannot be read, no tip is drawn: a tip
// is help, never worth a flash or an error on the page. A refused dismissal
// leaves the tip hidden for this view (the kit hides it on the press) and is
// not sent again; the next load asks the store afresh.

import { useEffect, useState, type ReactElement } from 'react';
import { SectionTip, type Tip, type TipPreferences } from '@launchastro/ui';
import { isRefusal, isUnavailable, type OperationsClient } from '../operations/client.ts';

interface PreferenceRead {
  readonly preferences: Readonly<Record<string, unknown>>;
}

/** The store's `tips.dismissed`, each entry that holds a whole-number version. */
function dismissedOf(preferences: Readonly<Record<string, unknown>>): Record<string, number> {
  const held = preferences['tips.dismissed'];
  if (typeof held !== 'object' || held === null) return {};
  return Object.fromEntries(
    Object.entries(held).filter((entry): entry is [string, number] => Number.isInteger(entry[1])),
  );
}

export function PageTip(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly tip: Tip;
}): ReactElement | null {
  const { client, grantKey, tip } = props;
  const [held, setHeld] = useState<Pick<TipPreferences, 'dismissed' | 'tipsOff'> | null>(null);
  useEffect(() => {
    let current = true;
    setHeld(null);
    void (async () => {
      const read = await client.read<PreferenceRead>('preference.read', {});
      if (!current || isRefusal(read) || isUnavailable(read)) return;
      const { preferences } = read.value;
      setHeld({
        dismissed: dismissedOf(preferences),
        tipsOff: preferences['tips.enabled'] === false,
      });
    })();
    return () => {
      current = false;
    };
  }, [client, grantKey]);
  if (held === null) return null;
  const preferences: TipPreferences = {
    ...held,
    dismiss: (_key, version) => {
      void client.mutate('preference.dismiss_tip', { page: tip.page, tip: tip.id, version });
    },
  };
  return <SectionTip tip={tip} preferences={preferences} />;
}
