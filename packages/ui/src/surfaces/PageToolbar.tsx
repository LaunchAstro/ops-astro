// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext } from 'react';

export const PageToolbar = createContext<HTMLElement | null>(null);

export function usePageToolbar(): HTMLElement | null {
  return useContext(PageToolbar);
}
