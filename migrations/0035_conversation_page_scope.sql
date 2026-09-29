-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0035 the page a conversation is about (MP-7-11, CS-7.31).
--
-- "Add page to context" makes the current page the conversation's scope: its
-- address and what it shows, as the person saw it. One slot: a second pointer
-- replaces the first and nothing accumulates, so the page is two columns on
-- the conversation, never a table of pointers. Both are set or neither is.
--
-- The address is a page of this product and nothing else: a path starting
-- with one slash, never two and never a slash then a backslash (either would
-- leave the product), printable ASCII only (no space, control character or
-- anything a browser would re-read), no backslash anywhere, at most 300
-- characters. The command refuses the same by name; this is the backstop.
-- What it shows is the page's own label: 1 to 200 characters, no control
-- characters.
--
-- The conversation's table grants already cover the columns (0033: select,
-- insert, update to the application), and the purge keeps them, as it keeps
-- the title and the subject: the page is what the conversation was about,
-- not what was said.

alter table public.conversations
  add column page_address text,
  add column page_shows text;

alter table public.conversations
  add constraint conversations_page_pair
    check ((page_address is null) = (page_shows is null)),
  add constraint conversations_page_address_in_product
    check (
      page_address is null
      or (
        char_length(page_address) <= 300
        and page_address ~ '^/([^/\\].*)?$'
        and page_address ~ '^[!-~]+$'
        and strpos(page_address, E'\\') = 0
      )
    ),
  add constraint conversations_page_shows_bounded
    check (
      page_shows is null
      or (char_length(btrim(page_shows)) between 1 and 200 and page_shows !~ '[[:cntrl:]]')
    );
