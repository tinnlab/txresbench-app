# TxResBench

TxResBench is a desktop application for clinicians who want to predict **treatment
response from repeated blood biomarker measurements** — for example response to
treatment at a chosen decision day, or risk of progression during follow-up — on
their own computer.

## What it does

- **Upload your data.** Two tables: one row per patient (the outcome, decision
  day, follow-up), and one row per measurement (a marker value at a date). No
  server, no account, no data leaves your machine.
- **Arrange the analysis.** Choose the outcome, the decision day, the prediction
  horizon and the covariates you want the methods to use.
- **Run many methods.** Select any number of methods from a catalogue of published
  approaches; each shows an estimated run time before you start it. Every method
  runs in its own isolated sandboxed environment on your machine.
- **See per-patient predictions.** A heatmap table of patients × methods, ready to
  export to CSV.
- **Save and reuse.** Trained models can be saved, reloaded and applied to new
  patients; a history of runs stays on your machine.

## Runs on your computer

Everything — data, analysis, trained models, history — stays on your computer.
The application makes no cloud calls and keeps no analytics or tracking. The only
times it uses the network are when it downloads a method's analysis environment
from the project's container registry (once per method) and when it checks for
application updates.

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
