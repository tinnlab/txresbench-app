# TxResBench

TxResBench is an app for clinicians who want to predict **treatment
response from repeated blood biomarker measurements** — for example response
to treatment at a chosen decision day, or risk of progression during
follow-up.

## What it does

- **Upload your data.** Two tables: one row per patient (the outcome, decision
  day, follow-up), and one row per measurement (a marker value at a date).
- **Arrange the analysis.** Choose the outcome, the decision day, the prediction
  horizon and the covariates you want the methods to use.
- **Run many methods.** Select any number of methods from a catalogue of published
  approaches; each shows an estimated run time before you start it. Every method
  runs in its own isolated sandboxed environment.
- **See per-patient predictions.** A heatmap table of patients × methods, ready to
  export to CSV.
- **Save and reuse.** Trained models can be saved, reloaded and applied to new
  patients; a history of runs is kept for each of them.

## Privacy

TxResBench does not track you and uses no analytics. Your files are used only to
run the analyses you start. You can delete runs, models and history yourself.

## Getting it

Download the installer for your platform from the **Releases** page of this
repository and double-click it. Linux (AppImage or deb), macOS and Windows
builds are published there.

## Licence

The source code is released under the
[PolyForm Noncommercial License 1.0.0](LICENSE) (see that file for the full
text): you may use it for personal and noncommercial purposes, including
research, education and public-health use, and you may change and redistribute
it under those terms — but **no commercial use** of the software is permitted
under this licence. Material in the repository that comes from other projects
keeps its own licence (see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md);
researchers and methods included in TxResBench carry their own terms).

If you need to use TxResBench commercially, contact the repository owner.
