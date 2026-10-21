# `fixtures/visium-hd-outs/`

A LAYOUT fixture, not a data fixture: every file holds a token, not real bytes. What it
exists to prove is that each of `spatial/visium-hd-bundle`'s twelve declared members
resolves to EXACTLY ONE path in the tree Space Ranger writes — which is a statement about
names and directories, and is exactly the statement that was false before #160.

The tree mirrors `docs/research/data-processing/01-file-formats.md:607-615` and
`docs/research/spatial-platforms/03-output-matrix.md:18`: three `square_NNNum/` bins, each
a full Visium `outs/` (matrix `.h5`, a MEX directory with the SAME basenames, a `spatial/`
with parquet positions, scalefactors and both images, and an `analysis/` tree), plus the
run-root files that are emitted once (`barcode_mappings.parquet`, `feature_slice.h5`,
`web_summary.html`, `metrics_summary.csv`).

The noise is load-bearing. `filtered_feature_bc_matrix/matrix.mtx.gz` appears in all three
bins, so a matcher that fell back to basenames would find three candidates; the
`raw_feature_bc_matrix.h5` and `tissue_lowres_image.png` siblings are there so a member
cannot pass by being the only `.h5` or the only `.png` in its directory.

**Not verified against a real bundle.** No Visium HD bundle was available; this is the
documented layout, and `DECISIONS.md` DEC-5 records what that means for the two run-root
files this container deliberately does not declare.
