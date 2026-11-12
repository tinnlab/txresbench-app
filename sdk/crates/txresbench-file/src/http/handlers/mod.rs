//! The store-generic file HTTP handlers moved from txresbench's `modules/file/handlers`
//! (chunk `txresbench-file-http`). Only the handlers that depend on nothing beyond the
//! store ([`crate::repository::FileRepository`] via [`super::context::FileContext`]),
//! the storage manager, the injected [`crate::seams::FileEvents`], and the
//! download-token signer moved here; the processing/pandoc/identity-recheck
//! handlers stayed txresbench-side (see [`super`]).

pub mod download;
pub mod management;
pub mod versions;

pub use download::*;
pub use management::*;
pub use versions::*;
