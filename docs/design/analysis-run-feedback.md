# Run feedback: submitted, running, and not-twice-by-accident

## Why

Today, clicking Run on a declarative analysis produces **nothing observable until the job
finishes**. The shipped `qc.run` is `run_processor → wait_for(completed) → toast(success)`,
so the only acknowledgement is the success toast, minutes later.

Three consequences, all observed:

1. A user cannot tell a submitted job from a click that did nothing. There is no per-analysis
   place to see "you have a run in flight".
2. With no acknowledgement, the rational response to an unresponsive button is to click it
   again. Every extra click is a real duplicate job consuming a sandbox slot.
3. Nothing distinguishes "re-run because I changed a parameter" from "click again because I
   was not sure the first one registered".

This is the same class as the defects this codebase has been removing all week: the system
knows a fact (the job id, its phase, the submitted params) and does not show it.

## The change

Three parts. They are separable and should land in this order, because each is useful alone.

### Part 1 — an acknowledgement on submit

`run_processor` acknowledges as soon as the job is CREATED, not when it completes. The
existing completion toast stays; this is additive.

**It belongs in the interpreter's `run_processor`, not in each view's `actions`.** A per-view
`toast:` declaration is a thing every processor author must remember, and the author who
forgets ships exactly today's behaviour. Same reasoning as the value excerpt being implicit
(DEC-1 there): a fix that depends on the author knowing about the problem does not fix the
problem.

### Part 2 — a per-analysis run list

Every analysis pane carries a list of ITS runs — id/short label, phase, started-at — with the
in-flight ones first. Clicking one opens the existing job detail surface.

**Core, not contributed.** "Your runs" is a host concern like the Run button's job wiring, not
something a processor knows about; a processor that forgot to declare it would silently lose
the feedback. INV-1/INV-2 say the VIEW owns what the user sees *of the analysis' own
vocabulary* — a run list is not that.

Scope: runs of THIS analysis in THIS project, owner-scoped by the same read-perm the jobs
endpoint enforces. It must update live — the sync channel already carries job phase, and
`useCatalogInvalidation` is the precedent for deriving from it rather than polling.

### Part 3 — no accidental duplicate

While a job with **byte-identical submitted params** for this analysis is IN FLIGHT, Run is
disabled and says why.

**Deliberate re-runs stay possible.** Once that job reaches a terminal phase, Run re-enables
even with unchanged params — re-running identical inputs is a legitimate act (the repo has a
re-run affordance and a provenance model built around it), and a compute is not required to
be deterministic. The guard is against the *accidental* second click, not against the user.

## Decisions

### DEC-1: the identity of a run is its submitted `(inputs, params)`, hashed

Not "the analysis id" — that would block two legitimate different-parameter runs. Not a
free-form label. The pair the run actually receives is what distinguishes them, and it is
already assembled at the launch site.

Hash the canonical serialization. Whatever produces it must be stable under key order, or the
guard becomes intermittent — which is worse than absent, because it will be blamed on
something else.

### DEC-2: the acknowledgement names the analysis, not "job submitted"

A generic toast is indistinguishable between two analyses run in quick succession. It carries
the analysis title and enough of the job identity to correlate with the run list.

### DEC-3: the disabled Run states its reason in the control, not only in a tooltip

The shipped precedent is already right: the QC Run button is visible-but-disabled with the
reason rendered beside it (`noInputAlert`), never hidden. Follow it. A control that is
disabled with no stated cause reads as broken.

### DEC-4: a failed submit is loud and does not leave a phantom entry

If `POST /api/jobs` fails, the acknowledgement must not appear, the run list must not gain a
row, and the failure must surface. A list that shows a run that does not exist is worse than
no list.

### DEC-5: the run list shows terminal runs too, bounded

Only-in-flight would make the panel empty most of the time and answer "did my click work?"
only during the window where the user is least likely to look. Show recent terminal runs as
well, bounded and newest-first. State the bound; an unbounded list on a long-lived project is
the cardinality mistake this repo's UI checklist calls out.

## Surfaces

- The interpreter's `run_processor` effect (Part 1, Part 3's in-flight state).
- The analysis pane shell — wherever `DeclarativeStack` composes an analysis' view files, since
  the list is per-analysis and not per-view-file.
- The jobs read + its sync entity (Part 2's live update).
- The existing job-detail surface for the click-through — reuse it; do not build a second.

## Acceptance

1. Clicking Run produces an acknowledgement naming the analysis, before the job completes.
2. The analysis pane lists that run, in flight, without a reload.
3. Clicking the entry opens the existing job detail for THAT job.
4. With the same params still in flight, Run is disabled and states why; when the job reaches a
   terminal phase, Run is enabled again with the params still unchanged.
5. Changing any input or param re-enables Run immediately, even with the first job in flight.
6. A submit that fails leaves no run-list entry and surfaces the failure.
7. A second analysis run in the same project does not appear in the first analysis' list.

---

# Part 4 — an actionable `alert`, so a view can guide its own user

## Why

Cell-filter's whole point is filtering on QC metrics, and a user arriving before any QC run
has no columns to filter on and no idea what to do about it. The analysis knows the answer;
its UI does not say it.

## It is a VIEW concern, and it is nearly expressible today

INV-2: the view owns what the user sees. "To filter on QC metrics, compute them first" is
cell-filter's author speaking to cell-filter's user about cell-filter's workflow — not a host
concern, and not something core should decide for every analysis.

The `alert` widget already exists and is already used exactly this way (`qc.yaml`'s
`noInputAlert`: `kind: alert`, `tone`, `when`, `text`). So the guidance itself needs NO new
machinery — cell-filter declares an alert.

**The one thing missing is that `alert` is text-only: it carries no action.** That is the whole
change — an OPTIONAL action on the existing kind, which every view inherits and no author is
obliged to use.

    - id: qcHint
      kind: alert
      tone: info
      when: <no usable criteria columns>
      text: To filter on % mitochondrial, gene counts and the rest, compute them first.
      action: <launch the analysis that produces `metadata-column`>

## Decisions

### DEC-6: the action's TARGET is derived, the guidance is authored

The text is cell-filter's to write. The target is not: writing `qc.10x` into
`cell-filter.yaml` puts one package's id inside another's view, and it breaks SILENTLY — a
dead link, not an error — the moment someone ships a different QC or a domain whose producer
is named otherwise.

Cell-filter already declares `consumes: [metadata-column]`. So the target resolves from the
view's OWN manifest: the analyses whose `produces` includes that type, matched through the
same lattice `appliesTo` uses. A new domain inherits the affordance with no edit.

### DEC-7: zero, one and several producers are three renderings

**one** — a direct affordance naming it. **several** — a choice; picking one arbitrarily is the
"only one match, selected automatically" mistake that bound a gene-names picker to ENSEMBL
ids. **zero** — render the text with no action rather than a link that goes nowhere.

### DEC-8: the action routes through `analysis.launch`

`analysis.launch` now REVEALS a view-backed analysis' own pane rather than opening a rival run
pane. The alert dispatches that same action, so this path and a launcher click stay identical.
Poking the dock directly would fork routing that was just unified.

### DEC-9: `when` decides visibility, and "empty" is not "unsuitable"

Always-on is noise once QC has run. But the condition is not simply "no columns" — a project
can have obs columns that are not QC metrics, and those are different sentences. If
distinguishing them is not cheap, ship the empty case only and say so; a wrong sentence is
worse than one fewer.

### DEC-10: an action on `alert` does not make `alert` a button

It stays an informational surface with an optional affordance. If the guidance is the primary
call to action, that is a `button` and the author should declare one. This is for "you are
looking at an empty thing, here is why and where to go".

## Acceptance (Part 4)

8.  Cell-filter's UI, on a project with no QC run, shows guidance naming what to do — with
    `qc.10x` written in no view file.
9.  Activating it reveals that analysis' pane, by the same route a launcher click takes.
10. A fixture analysis declaring `produces: [<type>]` becomes the target for an alert whose
    view `consumes` that type, with zero app or view edits. That is the invariant; cell-filter
    is the example.
11. With two producers of one type, both are offered; neither is auto-selected.
12. An `alert` with no action renders exactly as it does today — the field is additive and
    every existing alert is unchanged.
