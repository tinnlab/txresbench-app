# txrhelp

The Help content screen of the TxResBench app: the `/help` page the
`txrshell` scaffold used to render (route handoff — this module owns the
route; the shell's route block and the scaffold `ShellPage` it referenced
are removed on the same branch). Rebuilt as product documentation
(qa-fixes2 ITEM-3): the sticky contents rail at `>=1024 px` (a collapsed
"Contents" disclosure below it), the search box, the quick-start row, the
four-step cards, the per-file column tables, the status vocabulary, the
callouts and the troubleshooting accordion. The layout decisions and the
measured cases are in `DESIGN.md`.

The page is data-driven: `content.ts` holds the typed content
(`HelpSection` + `HelpBlock` + `HelpProblemEntry` in `types.ts`) and
`pages/HelpPage.tsx` is the one renderer — a wording change is a data
change with no code churn. The sections: what TxResBench does, the four
steps with what to click, preparing your files, choosing methods, the
status words on the screens, reading results, saved and pretrained models,
run history, privacy, what the app keeps, and troubleshooting with one
entry per validator problem code.

## The validator catalogue (one source, two sides)

`validator-catalog.json` is the machine fact of every problem code —
severity group and whether the app reports it — generated from the file
validator's own declaration tables (`rules.rs` `RULES` + `APP_RULES`,
rendered by `file_validator::catalog`). The server test
`catalog_roundtrip_and_committed_copy` byte-compares that file with a fresh
render; regenerate with
`bash scripts/file-validator/gen_help_catalog.sh` after a validator change
and commit both. The authored prose (meaning, action, plain title) sits in
`content.ts` keyed by code; a code without prose fails this module's tests.

## Routes

| screen | route | what the user sees |
|---|---|---|
| Help | `/help` | the quick-start row, the search box, the contents rail, the sections, and the troubleshooting accordion with anchor navigation; the deep links (`/help#problem-<code>`) land on the matching entry, cleared of the header and expanded |

The route is `requiresAuth: true` under the shell layout (`TxrLayoutDef`
from `txrshell/module.tsx`). The path builders live in `routes.ts` and are
re-exported by the barrel (`index.ts`): `helpPath(anchor?)` — sibling
modules navigate with the builder, never with a URL literal.

## Cross-module seams

- `txrintake` — the validation problems list (`TxrProblemList`) links each
  problem's code to its Help entry through `problemAnchorOf` (the barrel)
  + `helpPath` (the route builder): `Row 14: … R03 → /help#problem-r03`.
  The intake module declares `txrhelp` in its framework dependencies for
  that binding. The entries are the file validator's CLOSED 28-code
  vocabulary (`ProblemCode::ALL`, R01–R21 + A01–A07 — the two
  declared-not-applicable tidy ids, the five hold-by-construction rules
  (R09/R10/R11/R16/R17) and the one dual-severity code (A04) are shown in
  their own groups).
- `txrrun` + `txrlist` — the status vocabulary's labels and tones ARE
  those modules' exported constants (`STATE_LABEL`/`STATE_TONE`,
  `formatRunHeadline`, `TXRLIST_STATUS_COLORS`), so the Help chips cannot
  drift from the screens. The imports go through the sibling internals (the
  `txrintake` → `txrlist` precedent); `txrhelp` does NOT declare them in
  its framework dependencies — the declared graph is `txrrun →
  txrintake → txrhelp`, so declaring the reverse edge would be a manifest
  cycle (the loader throws), and the page is lazy-loaded, so the bundler
  edge is resolved after registration.

## Theming

The page uses the app's token layer (`assets/txr-theme.css`'s `--txr-*`),
so it follows the light and dark themes the rest of the app uses — it
deliberately does NOT use the kit token layer's near-black dark background
(the old page's wrong dark, R2-H6). The page is responsive: the two-column
grid becomes the contents disclosure under 1024 px, the stepper and
quick-start cards stack under 640 px, and the data tables scroll inside
their own pane (no page overflow). Print hides the rail, the search and the
back-to-top control.

## Copy source

The prose is plain, accurate to the shipped behaviour (DEC-5): it
describes what the app does — the screen names, the required columns, the
validator's rules, the estimate's model, the network uses — and carries
no work-status wording, no placeholders and no unfinished-work markers
(the repo's published-file rule; the boards' example NUMBERS are design
examples and appear nowhere here). The module's own files are shipped
copy: the node's design choices and drift records live in the node's
lifecycle docs, never in the module.
