//! Workstore project-extension: delete/duplicate cascade + summary (ITEM-12).
//!
//! There is no `repository.rs` here any more. It held exactly one function —
//! `copy_axes_to_project_in_tx`, a deep-copy of `workstore_axis_entry` rows into a
//! duplicated project. artifact-model ITEM-8 dropped that table under INV-3 (**an
//! axis IS its key artifact**), which dissolves the function rather than re-homing
//! it: duplicating a project already re-references every artifact row
//! (`CatalogRepository::copy_to_project_in_tx`), and if an axis IS its key artifact
//! then copying the artifact IS copying the axis. Catalog delete/copy were always
//! `CatalogRepository`'s, so nothing else lived here.

pub mod extension;

pub use extension::WorkstoreProjectExtension;
