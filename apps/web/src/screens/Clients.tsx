// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import { MADE_UP_BOOK, type ClientBook } from '../data/clients-book.ts';

export function ClientsScreen(props: { readonly book?: ClientBook | undefined }): ReactElement {
  const book = props.book ?? MADE_UP_BOOK;
  return <div className="clbook" data-clients={book.clients.length} />;
}
