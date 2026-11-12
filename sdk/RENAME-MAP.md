# Rename map

This repository is one standalone app, TxResBench, and it contains its SDK in `sdk/`. The SDK began life as a separate project
whose crates, packages and variables had other names. `scripts/rename/apply.py` converts between those names and the names used
here, so a change made in `sdk/` can still be contributed to the original project (see `sdk/CONTRIBUTING-UPSTREAM.md`).

| Kind | Original (SDK / predecessor app) | Here |
|---|---|---|
| Cargo packages and directories under `sdk/crates/` | `ziee-<name>` | `txresbench-<name>` |
| Rust identifiers and paths | `ziee_<name>` | `txresbench_<name>` |
| Rust type names | `Ziee<Name>` | `TxResBench<Name>` |
| npm packages | `@ziee/<name>` | `@txresbench/<name>` |
| App npm packages and crates | `@cytoanalyst/ui`, `@cyto/<name>`, `cytoanalyst`, `cytoanalyst-desktop`, `cytoanalyst_desktop_lib`, `cytoanalyst-root` | `@txresbench/ui`, `@txresbench/<name>`, `txresbench`, `txresbench-desktop`, `txresbench_desktop_lib`, `txresbench-root` |
| Environment variables | `ZIEE_<NAME>`, `CYTO_<NAME>`, `CYTO_TXR_<NAME>` | `TXR_<NAME>` |
| Python and other identifiers | `cyto_<name>`, `cyto-<name>`, `.cyto` (attribute key) | `txr_<name>`, `txr-<name>`, `.txr` |
| Display text | `CytoAnalyst`, `Ziee`, `Ziee AI`, `cyto` | `TxResBench`, `txresbench` |
| Registry | `ghcr.io/ziee-ai/cyto-env` | `ghcr.io/tinnlab/txresbench-env` |
| Organisation | `ziee-ai` | `tinnlab` |
| Media types and labels | `vnd.cyto.env`, `com.cytoanalyst.env` | `vnd.txresbench.env`, `com.txresbench.env` |

Words that merely contain the letters, such as cytometry, cytokine or cytoplasm, are never changed. Licence and notice files are
never rewritten.

The forward direction is exact. The reverse direction (`--reverse`, `sdk/` only) restores the SDK's names for the SDK-style
families (`txresbench-`, `txresbench_`, `@txresbench/`, `TXR_`, `TxResBench<Name>`); names that were already app-specific are not
reconstructed, so read a reversed diff before sending it upstream.
