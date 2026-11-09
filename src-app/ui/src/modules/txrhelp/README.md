# txrhelp

The Help content screen of the TxResBench app: the `/help` page the
`txrshell` scaffold used to render (route handoff — this module owns the
route; the shell's route block and the scaffold `ShellPage` it referenced
are removed on the same branch).

The page is data-driven: `content.ts` holds the typed content
(`HelpSection` + `HelpProblemEntry` in `types.ts`) and `pages/HelpPage.tsx`
is the one renderer — a wording change is a data change with no code churn.
The sections: what TxResBench does, the four steps with what to click,
preparing your files, choosing methods, reading results, saved and
pretrained models, run history, privacy, what the app keeps,
and troubleshooting with one entry per validator problem code.

## Routes

| screen | route | what the user sees |
|---|---|---|
| Help | `/help` | the table of contents + the sections, with anchor navigation; the deep links (`/help#problem-<code>`) land on the matching troubleshooting entry |

The route is `requiresAuth: true` under the shell layout (`TxrLayoutDef`
from `txrshell/module.tsx`). The path builders live in `routes.ts` and are
re-exported by the barrel (`index.ts`): `helpPath(anchor?)` — sibling
modules navigate with the builder, never with a URL literal.

## Cross-module seam

- `txrintake` — the validation problems list (`TxrProblemList`) links each
  problem's code to its Help entry through `problemAnchorOf` (the barrel)
  + `helpPath` (the route builder): `Row 14: … R03 → /help#problem-r03`.
  The intake module declares `txrhelp` in its framework dependencies for
  that binding. The entries are the file validator's CLOSED 28-code
  vocabulary (`ProblemCode::ALL`, R01–R21 + A01–A07 — the two
  declared-not-applicable tidy ids and the four hold-by-construction rules
  are marked "not reported by the app").

## Theming

The page uses the kit token layer's CSS variables (`--background`,
`--foreground`, `--muted-foreground`, `--border`, `--primary`, `--muted`,
`--card`, `--destructive`, `--warning`), so it renders correctly in light
and dark without a page-local palette — deliberate for a long-form
content screen (the analysis screens keep the boards' fixed palettes).
The page is responsive: the TOC stacks above the sections at phone width
and the data tables scroll inside their own pane (no page overflow).

## Copy source

The prose is plain, accurate to the shipped behaviour (DEC-5): it
describes what the app does — the screen names, the required columns, the
validator's rules, the estimate's model, the network uses — and carries
no work-status wording, no placeholders and no unfinished-work markers
(the repo's published-file rule; the boards' example NUMBERS are design
examples and appear nowhere here). The module's own files are shipped
copy: the node's design choices and drift records live in the node's
lifecycle docs, never in the module.
