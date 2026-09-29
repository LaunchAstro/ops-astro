// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-3-1 stub, replaced by the change that follows the red tests.

import type { ReactElement, ReactNode } from 'react';

export interface DockTab {
  readonly id: string;
  readonly label: string;
  readonly count: string | null;
  readonly open: boolean;
}

export interface DockPanel {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly door: string;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly body: ReactNode;
}

export interface DockProps {
  readonly tabs: readonly DockTab[];
  readonly panels: readonly DockPanel[];
  readonly onTab: (id: string, shift: boolean) => void;
  readonly onClose: (id: string) => void;
  readonly onCloseAll: () => void;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onDoor: (href: string) => void;
}

export function Dock(props: DockProps): ReactElement {
  return (
    <div className="dock__rail" role="group" aria-label="Side panels">
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          className="dock__tab"
          type="button"
          aria-expanded={tab.open}
          aria-label={`${tab.open ? 'Close' : 'Open'} ${tab.label}${tab.count === null ? '' : `, ${tab.count}`}`}
          onClick={() => {
            props.onTab(tab.id, false);
          }}
        >
          <span aria-hidden="true">{tab.label.slice(0, 1)}</span>
          {tab.count === null ? null : (
            <span className="dock__n" aria-hidden="true">
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
