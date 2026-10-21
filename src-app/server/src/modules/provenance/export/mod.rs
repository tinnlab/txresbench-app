//! The phase-1 export wedge (ITEM-16..21): backward-walk scoping →
//! reproduce-script → methods → RO-Crate-shaped manifest → BagIt-RO bundle, plus
//! the reproducibility-readiness checklist.

pub mod bundle;
pub mod manifest;
pub mod methods;
pub mod readiness;
pub mod reproduce_script;
pub mod scope;
