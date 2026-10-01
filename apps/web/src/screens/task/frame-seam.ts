// SPDX-License-Identifier: AGPL-3.0-only
export interface FrameFacts {
  readonly viewport: number;
  readonly railExpanded: boolean;
  readonly panels: number;
  readonly asked: number;
}

export interface FrameFactsSource {
  readonly provenance: 'real' | 'mock';
  readonly useFacts: () => FrameFacts;
}
