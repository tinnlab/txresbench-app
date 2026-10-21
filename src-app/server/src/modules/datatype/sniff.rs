//! The sniffer (ITEM-13): ordered ext+magic detection → a candidate datatype id.
//! Galaxy sniff order — a magic-byte signature beats a file extension. Wired into
//! the upload path so an upload becomes a TYPED source artifact; also exposed at
//! `POST /api/datatypes/sniff` for the FE upload picker.

use super::registry::DatatypeRegistry;

/// The max number of leading bytes a caller reads for magic detection (a bounded
/// head read; DEC-16). Fixed — a detection detail, not an operator knob.
pub const SNIFF_MAGIC_BYTES: usize = 512;

/// Detect the datatype of an uploaded file from its `filename` (extension) and its
/// leading `magic` bytes. Magic wins over extension; among equal matches, the
/// lowest datatype id (deterministic). `None` = unrecognized (the caller shows
/// "unknown", never a crash).
pub fn sniff(registry: &DatatypeRegistry, filename: &str, magic: &[u8]) -> Option<String> {
    // Candidate types with an ingest spec, id-sorted for a deterministic tiebreak.
    let mut candidates: Vec<&crate::modules::datatype::types::Datatype> = registry
        .all()
        .into_iter()
        .filter(|d| d.ingest.is_some())
        .collect();
    candidates.sort_by(|a, b| a.id.cmp(&b.id));

    // Pass 1 — magic beats extension.
    for dt in &candidates {
        let spec = dt.ingest.as_ref().unwrap();
        for hex in &spec.magic_hex {
            if let Some(sig) = decode_hex(hex) {
                if !sig.is_empty() && magic.len() >= sig.len() && magic[..sig.len()] == sig[..] {
                    return Some(dt.id.clone());
                }
            }
        }
    }

    // Pass 2 — extension match.
    let ext = extension_of(filename);
    if let Some(ext) = ext {
        for dt in &candidates {
            let spec = dt.ingest.as_ref().unwrap();
            if spec.extensions.iter().any(|e| e.eq_ignore_ascii_case(&ext)) {
                return Some(dt.id.clone());
            }
        }
    }
    None
}

/// The lowercased extension (without the dot) of a filename, if any.
fn extension_of(filename: &str) -> Option<String> {
    let name = filename.rsplit(['/', '\\']).next().unwrap_or(filename);
    let (_, ext) = name.rsplit_once('.')?;
    if ext.is_empty() {
        None
    } else {
        Some(ext.to_ascii_lowercase())
    }
}

/// Decode a lowercase hex string (`"504b0304"`) to bytes; `None` on a malformed one.
fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::datatype::registry::DatatypeRegistry;

    fn reg() -> DatatypeRegistry {
        // The sniffable domain types (`single-cell/multimodal` h5mu,
        // `single-cell/anndata` h5ad/magic, `single-cell/expression` h5/mtx) are
        // manifest-contributed now → build the MERGED registry (roots ∪ contributions),
        // as boot does.
        DatatypeRegistry::build_from_embedded().unwrap()
    }

    // TEST-12: ext detection, magic beats ext, ambiguous order, unknown → None.
    #[test]
    fn sniff_paths() {
        let r = reg();
        // Extension: .h5mu → `single-cell/multimodal` (only multimodal lists h5mu).
        assert_eq!(
            sniff(&r, "data.h5mu", b""),
            Some("single-cell/multimodal".into())
        );
        assert_eq!(sniff(&r, "report.html", b""), Some("report/html".into()));
        // A plain `.csv` is no longer claimed by any type (the producer-less `de` type
        // was pruned — a generic CSV is not "differential expression") → unknown.
        assert_eq!(sniff(&r, "results.csv", b""), None);

        // Magic beats extension: a `.csv` name but a zip/zarr magic → anndata.
        let zip_magic = [0x50u8, 0x4b, 0x03, 0x04, 0x00, 0x00];
        assert_eq!(
            sniff(&r, "data.csv", &zip_magic),
            Some("single-cell/anndata".into())
        );

        // Ambiguous ext (.h5ad listed by both expression + anndata), no magic → the
        // id-sorted first (`single-cell/anndata` < `single-cell/expression`).
        assert_eq!(sniff(&r, "x.h5ad", b""), Some("single-cell/anndata".into()));

        // Unknown: no ext match, no magic.
        assert_eq!(sniff(&r, "mystery.xyz", b"\x00\x01"), None);
        assert_eq!(sniff(&r, "noext", b""), None);
    }

    #[test]
    fn hex_and_ext_helpers() {
        assert_eq!(decode_hex("504b0304"), Some(vec![0x50, 0x4b, 0x03, 0x04]));
        assert_eq!(decode_hex("50b"), None); // odd length
        assert_eq!(extension_of("a/b/c.TSV"), Some("tsv".into()));
        assert_eq!(extension_of("noext"), None);
    }
}
