# txrhelp DESIGN — the Help page's layout decisions (qa-fixes2 ITEM-3)

1. **Two columns, both real.** The desktop grid is 240 px sticky rail +
   760 px content (60–75 char lines), centred in the window — the old page
   put a 220 px sticky list in a wrapping flex row, so the content wrapped
   under it and the list drew over the article (R2-H1/H2).
2. **The rail is a nav, not a list of text.** Sticky with its own scroll,
   the current section highlighted; under 1024 px it disappears entirely and
   a collapsed "Contents" disclosure takes its place, plus a floating
   "Back to top" — no overlay, ever.
3. **One line of prose maximum.** Every section opens with one sentence and
   moves to the visual form: bullets, cards, tables, chips — the four steps
   are four numbered cards (big number, name, two short lines, screen chip,
   expandable details).
4. **The file spec is a table, not prose.** Per file: a card with the
   column table (mono name chips, required/optional pills, sticky header,
   zebra rows, example column), "Copy example rows" (the app's own example
   bytes) and the app's template download.
5. **Control is data-driven.** No prose owns a fact: the problem-code list
   is generated from the validator's own declaration tables (committed
   catalogue), the status chips use the sibling modules' label/tone
   constants, and the quick-start cards mirror the Start screen's three
   ways.
6. **The palette is the app's.** `--txr-*` tokens only (the kit token
   layer's near-black dark background was the wrong dark — R2-H6); callouts
   are Tip / Note / Watch out with an icon, a 3 px accent bar and a tinted
   fill, ≥ 4.5:1 in light and dark.
7. **Search is the finder.** One client-side box filters sections and
   troubleshooting entries, highlights matches, has a "no results" state;
   the rail stays the navigation.
8. **Type scale:** one h1 (serif 30), h2 per section (serif 21), h3 inside
   cards (serif 16/15), Source Sans 3 body at 14.5, mono for columns and
   codes — the design faces, the boards' rhythm.
9. **Accessibility:** skip link, nav/main/search landmarks, headings in
   order, kit controls and their focus ring, smooth scroll that respects
   `prefers-reduced-motion`, print stylesheet (no rail, no search, no back
   to top), document title "Help — TxResBench".
10. **Verification is measured, not eyeballed:** the gallery spec runs
    1440×900 / 1024×768 / 768×1024 / 390×844 in both themes and asserts no
    overlap, the 600–760 px column, the < 5,500 px page, scroll-inside
    tables, contrast ≥ 4.5:1, working search and the `#problem-<code>`
    deep link.
