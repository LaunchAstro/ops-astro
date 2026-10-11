// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext } from 'react';

export const PageToolbar = createContext<HTMLElement | null>(null);
export const PageTitle = createContext<HTMLElement | null>(null);

export function usePageTitle(): HTMLElement | null {
  return useContext(PageTitle);
}

export function usePageToolbar(): HTMLElement | null {
  return useContext(PageToolbar);
}

export const panelToolbar = createContext<HTMLElement | null>(null);
export function usePanelToolbar(): HTMLElement | null {
  return useContext(panelToolbar);
}
