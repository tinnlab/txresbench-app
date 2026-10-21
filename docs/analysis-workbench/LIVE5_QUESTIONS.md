# LIVE5 QUESTIONS — Study Analysis Workflow

## ✅ ROUND-1 pick (answered) — Candidate **D**, INTERFACE-ONLY scope
User picked **Candidate D** ("Guided Pipeline + Explorer") and reframed scope to **interface/UX only**
this round (no data model / jobs / backend), with the crux: *tens of analyses will plug in — design it
UX-friendly for a biologist but with all the advanced stuff on demand.* → delivered `INTERFACE_DESIGN.md`
(the extensible analysis-plugin framework + progressive-disclosure shell) + an **interactive mockup**.

---

## ✅ ROUND-2 pick (answered) — **V2 Explorer-centric** + **build real gallery components**
User chose **V2** (explorer-centric shell: persistent WebGL canvas + analyses dock + results overlay +
collapsible context panel; biologist on-ramp via the empty-state "Run standard analysis" CTA) and to build
it as **real on-system gallery components on mock data**, gate:ui-green, under the feature-lifecycle. Design
locked in `INTERFACE_DESIGN.md §6`. Defaults taken for the sub-questions: `Samples` + `Workspace` sections;
seed analyses = qc.filter, normalize.lognorm, dimensionality.pca, integration.harmony, clustering.leiden,
embedding.umap, markers.wilcoxon, annotation.reference. → **NOW: feature-lifecycle Phase 1 (PLAN.md).**

---

## (historical) ROUND-2 decision — pick the SHELL DIRECTION before I build it for real

The extensible framework (analysis-plugin contract + progressive disclosure + catalog) is settled. What's
open is the **shell metaphor**. The interactive mockup renders all three on-system (switch them at the top;
also try the Simple→Advanced disclosure on the Leiden form, the "Add analysis" catalog, the Samples QC
cards, and the Explore color-by/gene).

| Dir | Shell | Feel | Trade |
|---|---|---|---|
| **V1 ⭐** | **Timeline + Workspace** | left run-timeline (history + branch anchor) · center = form ⟷ result · catalog overlay | legible guided pipeline; scales via catalog; **recommended** |
| V2 | Explorer-centric | WebGL scatter is the persistent canvas; analyses dock beside it | most cellxgene-like; weaker pipeline legibility for first-time biologists |
| V3 | Recipe + Library | guided recipe card + a separate full "analysis library" tab | friendliest on-ramp; two-surface split can feel like two apps |

**My recommendation: V1** as the frame + V3's "Run standard analysis" recipe on-ramp embedded in its header
+ V2's explorer as the `Explore` section — fuses the strengths.

### Also confirm (defaults in brackets, I'll use them unless you say otherwise):
- **Q-A — Section layout:** three sections `Samples / Analysis / Explore` [default] vs one "Analysis"
  section with internal tabs?
- **Q-B — Build target this round:** build the chosen direction as **real on-system gallery components on
  mock data**, `gate:ui`-green, under the feature-lifecycle [default] — vs iterate the mockup further first?
- **Q-C — Seed analyses to include** (proves the framework spans categories/prereqs/recipe):
  `qc.filter, normalize.lognorm, dimensionality.pca, integration.harmony, clustering.leiden, embedding.umap,
  markers.wilcoxon, annotation.reference` [default].

**Say "V1, go" (or pick a direction + answer A/B/C) and I'll write Phase-1 `PLAN.md` and build it.**
Nothing is implemented until you pick the direction.
