//! The coarse storage-layout vocabulary (ITEM-4).
//!
//! **What this module used to be, and why it shrank.** It held the typed-binary
//! decoders + the COO `RecordBatch` contract + the selector→index seam that the
//! Selection→Arrow serve core (`serve_core.rs`) read artifact bytes through.
//! artifact-model ITEM-12 deleted that core under INV-1 — *the server stores and
//! serves, it never opens a byte for meaning* (as amended 2026-08-17, DEC-23: the GATHER may decode the writer's chain — `sharding_indexed`+`gzip`+`numcodecs.shuffle` — in `workstore/gather_decode.rs` and nowhere else) — so every one of those pieces lost its
//! only caller and went with it:
//!
//! - `coo` (the Arrow COO contract) — the sole reason this crate linked `arrow`.
//! - `legacy_oracle` (a `#[cfg(test)]` byte-equivalence oracle) — an oracle for a
//!   serve arm that no longer exists.
//! - `decode_i64_le` / `decode_u32_le` / `decode_f32_le` — the CSC `indptr`/`indices`/
//!   `data` decoders. That decode now happens in the BROWSER, off byte ranges over
//!   `GET /artifacts/{id}/data/{*member}` (`ui/src/core/workstore/artifactReader.ts`).
//! - `LayoutResolver` / `IdentityResolver` — the semantic-selector → layout-index seam,
//!   i.e. the server half of the Selection grammar.
//! - `StorageLayout::parse` (string → enum) — the serve core's routing read
//!   `parse(&artifact.storage_layout)` to pick a serve arm. It was the ONLY production
//!   caller, so `parse` lost its reason to exist in the very commit that deleted the
//!   core; it survived that commit un-noticed, listed nowhere, kept alive by a unit test
//!   that only re-asserted its own `_ => Opaque` fallback. Removed now. (It was also an
//!   INV-2 hazard in waiting: a silent default that turns any unrecognized string into a
//!   valid-looking layout is exactly the shape that lets an unknown value be *acted on*
//!   instead of refused.)
//!
//! What REMAINS is the layout vocabulary itself, in ONE direction: enum → string.
//!
//! **ITEM-7 has now landed and this enum did NOT go with it.** The earlier note here
//! predicted that dropping `artifacts.storage_layout` would leave the enum with no
//! consumer. It dropped the COLUMN — the host no longer persists a layout per row, and
//! the row's self-description is the producer-declared `structure` — but the vocabulary
//! kept a real consumer, and the path that reaches it is exactly one:
//! `datatype::validate_artifact_typing` compares the layout a MANIFEST ENTRY declares for
//! an output against the layout its DATATYPE declares, via
//! `LayoutKind::as_storage_layout` → `LayoutKind::to_storage_layout` → [`StorageLayout::as_str`].
//! Every surviving consumer arrives through [`StorageLayout::as_str`]; NOTHING parses a
//! layout string back into this enum. That is a declaration-vs-declaration check on the
//! write path — no byte is opened and nothing is stored — so it survives INV-1 and INV-2
//! intact. The single string table lives here so `LayoutKind` maps onto it instead of
//! re-declaring the spellings.

/// Domain-neutral storage layouts, as a string tag on the artifact row.
///
/// The host never *acts* on this — it compares two DECLARATIONS with it (an output
/// manifest entry's `layout` against its datatype's `StorageSpec.layout`) and is
/// otherwise blind to it. Since ITEM-7 it is no longer persisted on the artifact row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageLayout {
    ChunkedDense,
    ChunkedSparse,
    ColumnarTable,
    Chunked1d,
    Opaque,
}

impl StorageLayout {
    /// The layout's wire/DB spelling. This is the ONLY direction the table is used
    /// in — see the module doc; there is deliberately no `parse` back the other way.
    pub fn as_str(self) -> &'static str {
        match self {
            StorageLayout::ChunkedDense => "chunked-dense",
            StorageLayout::ChunkedSparse => "chunked-sparse",
            StorageLayout::ColumnarTable => "columnar-table",
            StorageLayout::Chunked1d => "chunked-1d",
            StorageLayout::Opaque => "opaque",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the layout STRING TABLE — the vocabulary a contributed manifest writes as
    /// an output's `layout` and a datatype declares as its `StorageSpec.layout`, which
    /// `datatype::validate_artifact_typing` compares as strings. A silent rename here
    /// would stop matching every shipped manifest, so every arm's spelling is asserted.
    ///
    /// This replaced a parse→`as_str` ROUND-TRIP test. `StorageLayout::parse` was
    /// removed with the serve core that was its only caller, and the round-trip's one
    /// surviving assertion certified nothing but `parse`'s `_ => Opaque` default — a
    /// test whose whole subject was code that should not exist.
    #[test]
    fn as_str_pins_the_layout_string_table() {
        assert_eq!(StorageLayout::ChunkedDense.as_str(), "chunked-dense");
        assert_eq!(StorageLayout::ChunkedSparse.as_str(), "chunked-sparse");
        assert_eq!(StorageLayout::ColumnarTable.as_str(), "columnar-table");
        assert_eq!(StorageLayout::Chunked1d.as_str(), "chunked-1d");
        assert_eq!(StorageLayout::Opaque.as_str(), "opaque");
    }
}
