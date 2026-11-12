# Workbench Information Architecture — research synthesis + recommendation

Deep research across **16+ data-heavy workbenches** in three unrelated domains, to ground the redesign of
the study analysis workbench (WebGL embedding scatter + metadata/gene selectors + DE/marker tables +
lasso→annotate loop). Prompted by human feedback (FB-1/FB-2): the shipped UI is shallow + the IA is wrong.

## Tools studied
- **DB/SQL workbenches:** MySQL Workbench, DataGrip, DBeaver, pgAdmin, TablePlus, Azure Data Studio, Navicat, Snowsight, BigQuery.
- **Data-science / BI:** RStudio, Spyder, MATLAB, JupyterLab, Hex/Deepnote/Observable, Tableau, Power BI, KNIME, Orange, Graphistry, Metabase, Superset.
- **Docking / sci-viz / observability:** VS Code, JetBrains (IntelliJ/DataGrip), Eclipse, Visual Studio; cellxgene, Loupe, BBrowser, IGV, UCSC, napari, Gephi; Kibana/Elastic Discover, Grafana, Splunk, Datadog.
- **Internal reference:** legacy TxResBench `sc-website` analysis page (`txresbench-ref`).

## The universal "IDE-shell" region model (convergent across all 16, 3 domains)
```
┌── THIN TOP TOOLBAR: dataset/embedding · plot-type · layout · color-by · run · presets ──┐
│ LEFT dock    │                                                    │ RIGHT dock          │
│ NAVIGATE     │            CENTER CANVAS (the one hero)            │ INSPECT / detail    │
│ metadata +   │       embedding scatter (UMAP/tSNE/spatial)        │ selection · stats · │
│ gene search  │       + lasso/brush inline                         │ top DE genes ·      │
│ (click→color)│                                                    │ assign-annotation   │
│              ├─────────────────────────────────────────────────────┤                     │
│              │  BOTTOM dock: RESULTS — DE / marker tables + log    │                     │
│ →stripe      │  (wide → full width) · analysis config lives here   │  →stripe            │
└──────────────┴─────────────────────────────────────────────────────┴─────────────────────┘
```
- **left = navigate** (metadata + genes) — unanimous (VS Code sidebar, JetBrains Project, cellxgene metadata, napari layers, Kibana/Splunk/Datadog fields).
- **bottom = results/output** — strong (VS Code panel, DataGrip results, Discover table, napari dims). **Wide tables go here for the full-width argument** (a DE table = gene,logFC,p,p.adj,pct.1,pct.2,… → needs full width → below, never beside).
- **right = inspect/detail** — strong (VS Code secondary sidebar, cellxgene DE genes, Gephi context, Datadog log-detail flyout). First to hide.
- **thin top toolbar** — universal.
- **center = one hero canvas, never a tab, never split by default** — universal, non-negotiable.

## The single-cell consensus (cellxgene / Loupe / BBrowser — our exact problem, independently converged)
- **Left = metadata fields** (categorical + numeric); a **single CLICK colors the embedding** (not a drag).
- **Center = the embedding scatter, pinned, dominant, never reflows on recolor.**
- **Right = gene search + expression + the color legend + selection detail + top-DE genes.**
- **Selection is the first-class driver:** lasso on the embedding → drives violin / crosstab / DE, and **writes back** as a new annotation category (cellxgene). This is textbook **brushing-and-linking** (Becker & Cleveland 1987) + write-back.
- cellxgene nuance: it **splits** metadata (left) from genes+DE (right); the legacy TxResBench put Observations+Features both left and analysis+tables in a bottom drawer. Both work.

## Decisions the research settles (correcting the shipped build)
1. **Canvas is king — invert the SQL/IDE default.** In DB/IDE tools the editor is central; here the **embedding scatter is the permanent central hero**; params/analyses are docks around it, not the center. (Graphistry / cellxgene / napari.)
2. **Analysis + its wide data tables → BOTTOM dock, full width** (the wide-table argument). NOT a right rail (too narrow → horizontal-scroll every DE table), NOT a modal dialog (KNIME's weakness — hides the plot you must reference), NOT scroll-away notebook cells. Results are **deliverables, resizable peers of the canvas**, selection-driven.
3. **"What to visualize" → LEFT rail, click-to-color** (metadata + gene search). High-frequency browse-and-pick → left (reading order, Tableau's argument). Genes may live right (cellxgene split) if width allows.
4. **Selection inspector → persistent RIGHT dock with write-back** (Datadog-style flyout, not inline-expand — users iterate selections and want it stable). Closes the lasso→annotate loop.
5. **Fixed collapsible slots, NOT free docking.** The newest, most UX-researched consoles (Snowsight, BigQuery) chose fixed regions + resizable/collapsible splitters over the older IDEs' free float/detach. The **legacy TxResBench's full pin/float/pop-out docking is over-engineered** for episodic-use scientists → predictability + teachability win. Ship a **"Reset layout."**
6. **Collapse-to-labeled-stripe, not binary on/off.** JetBrains/Visual Studio: a closed dock shrinks to a ~24px labeled stripe on its edge, one click to reopen — canvas maximal by default, every panel discoverable (users don't forget it exists). Better than VS Code's plain ⌘B/⌘J toggle.
7. **Small-multiples + plot-type as a canvas layout mode** (legacy "Separate", cellxgene/UCSC dual-pane): the center can show linked side-by-side panels (cluster · annotation · gene-A · gene-B) with **synced brushing**, and non-scatter plots (violin, volcano, histogram) — a top-toolbar layout/plot-type control.
8. **Quiet dark chrome, dense data.** The legacy `vis*_dark` shows the lesson: near-black, muted borders, chrome nearly invisible so the **data is the only color**, thousands of densely-packed cells forming the real manifold. My earlier glowy-teal-glass redesign over-designed the chrome — wrong. Data-forward, not chrome-forward.

## Recommended IA for the workbench (validated)
- **Top:** thin toolbar — dataset/embedding switch · plot-type (scatter/violin/…) · layout (single/split) · color-by indicator · Run · Export · Reset-layout.
- **Left dock (collapsible→stripe):** **Visualize** — Metadata (obs columns, click→color) + Genes (search + list, click→color).
- **Center:** the embedding hero — dense WebGL scatter, lasso/brush inline, floating legend, single or linked small-multiples.
- **Right dock (collapsible→stripe):** **Selection inspector** — N selected · composition/stats · Assign annotation (write-back) · top-DE genes.
- **Bottom dock (collapsible→stripe, resizable):** **Analysis + data** — tabs: Differential Expression (wide table) · Markers · Clustering · Annotation · Log/provenance; each = config + full-width result table.
- **Selection wires them all** (brushing-and-linking): lasso → inspector + violin + DE; assign → new metadata on the left.

**One-line target:** *center-pinned dense embedding hero · left = metadata + genes (click-to-color) · right = selection inspector (write-back) · collapsible bottom = DE/marker tables + analysis · quiet dark chrome · collapse-to-stripe · fixed (not free) docking.* This is simultaneously the single-cell-domain standard (cellxgene) and the universal data-workbench shell (VS Code/JetBrains/Kibana), hardened with Graphistry's canvas-hero discipline and the DB-workbench wide-table results rule.

### Sources
Per-tool docs cited in the three research streams (MySQL WB/DataGrip/DBeaver/pgAdmin/TablePlus/ADS/Navicat/Snowsight/BigQuery; RStudio/Spyder/MATLAB/JupyterLab/Hex/Tableau/PowerBI/KNIME/Superset/Metabase; VS Code/JetBrains/cellxgene/Loupe/BBrowser/IGV/UCSC/napari/Gephi/Kibana/Grafana/Splunk/Datadog) + brushing-and-linking lineage (Becker & Cleveland 1987; Buja 1991; "Interactive Dynamics for Visual Analysis", CACM).
