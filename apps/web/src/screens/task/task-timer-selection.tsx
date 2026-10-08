// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext } from 'react';
export const TaskTimerSelection = createContext<(() => void) | null>(null);
export const useTaskTimerSelection = (): (() => void) | null => useContext(TaskTimerSelection);
