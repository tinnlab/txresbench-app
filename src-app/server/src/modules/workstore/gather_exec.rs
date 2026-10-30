//! **ITEM-31 — ONE gather, used by the browser AND by a sandboxed processor.**
//!
//! The serve path produces a chunk on demand; stage-time materialisation writes the whole
//! store to disk so a processor reads an ordinary file. Both are the SAME resolution and the
//! SAME assembly, and that is the point rather than a convenience: two gathers that agree
//! today are two gathers that will disagree later, and the browser and a processor
//! disagreeing about one column's values is the worst available shape of that — each would
//! be internally consistent, and nothing would say which was right.
//!
//! ## Why staging cannot simply hardlink
//!
//! Sandbox inputs are staged by hardlinking pooled blobs (`sandbox/inputs.rs`: "the staged
//! file IS the pooled blob"). A gathered artifact has no blob — that is its defining
//! property — so there is nothing to link. It is materialised instead: the coordinator
//! gathers it through the alignment into an ordinary zarr store, and the processor is none
//! the wiser (INV-8).
//!
//! **The refusal that stood here before must never become an empty directory.** A processor
//! reading a legitimately-empty input is the blank-surface failure one layer down: every
//! step succeeds, the numbers are wrong, and nothing anywhere says so. Materialisation
//! either produces the whole store or fails by name.

use std::path::Path;

use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use ziee_core::AppError;

use super::catalog::repository::CatalogRepository;
use super::object_store::ObjectStore;

/// A gathered column, resolved and ready to assemble.
///
/// Holding the decoded source bytes is deliberate: the alternative — re-resolving per chunk —
/// would re-run the digest prechecks per request and re-decode the same shards, and a
/// materialisation writing N chunks would do it N times.
pub struct ResolvedGather {
    /// Per OUTPUT row: `(source index, row within that source)`.
    pub row_plan: Vec<(usize, usize)>,
    /// Per source: its decoded element bytes.
    pub sources: Vec<Vec<u8>>,
    /// Element width of the gathered column.
    pub item: usize,
    /// Output rows.
    pub n: usize,
    /// The gathered artifact's own declaration, for the synthetic `zarr.json`.
    structure: Value,
    /// A SPLIT STRING column's two members, when this column is one. `None` for a
    /// fixed-width column.
    pub strings: Option<super::gathered::GatheredStrings>,
    /// The unified level vocabulary for this column, verbatim from the alignment's group
    /// attributes. `None` for a column the alignment does not remap.
    levels: Option<Value>,
    /// **Which entry of `levels` MEANS "not in this vocabulary"** (DEC-27), verbatim from the
    /// alignment's `attributes.cyto_alignment.missing_levels[<column>]`. `None` when the run
    /// dropped nothing, which is the common case.
    missing_level: Option<Value>,
    /// Elements per chunk, from that declaration — the SAME number `synthetic_zarr_json`
    /// writes, so the declaration and the assembly cannot disagree.
    chunk_elements: usize,
}

impl ResolvedGather {
    /// **Roughly how much heap this resolution holds** — the weight the cache budgets in.
    ///
    /// Approximate on purpose: it counts the three unbounded parts (the row plan, the decoded
    /// source columns, a split column's two buffers) and ignores the fixed-size declarations
    /// beside them. A budget that mis-states an entry by a few hundred bytes still bounds; one
    /// that ignores a `Vec<u8>` per source does not.
    pub fn footprint_bytes(&self) -> usize {
        let plan = self.row_plan.len() * std::mem::size_of::<(usize, usize)>();
        let sources: usize = self.sources.iter().map(Vec::len).sum();
        let strings = self
            .strings
            .as_ref()
            .map(|s| s.values.len() + s.offsets.len() * std::mem::size_of::<u32>())
            .unwrap_or(0);
        plan + sources + strings
    }

    /// The member path this store serves its one column under — `values` (DEC-26).
    pub fn member_path(&self) -> String {
        super::gathered::gathered_member_path(&self.structure)
    }

    /// Is this a SPLIT STRING column (two members) rather than a flat one?
    pub fn is_split(&self) -> bool {
        self.strings.is_some()
    }

    /// The GROUP node at the store root, carrying the artifact's declaration.
    fn group_zarr_json(&self) -> Result<Value, AppError> {
        super::gathered::gathered_group_zarr_json(&self.structure)
    }

    /// The ARRAY node for a FLAT column's member, carrying the unified vocabulary when the
    /// column is a fused categorical.
    ///
    /// **The levels ride the ARRAY node, beside `kind`** — measured off the real writer
    /// (`level_0_group.zarr/values/zarr.json`), and it is where `readCategoricalColumn`'s
    /// `array.cyto?.levels` and `cyto_zarr_read.read_column`'s `attributes.cyto.kind` both
    /// already look. They used to be stamped on a ROOT array no client path could reach.
    fn flat_array_zarr_json(&self) -> Result<Value, AppError> {
        super::gathered::gathered_array_zarr_json(
            &self.structure,
            self.levels.as_ref(),
            self.missing_level.as_ref(),
        )
    }

    /// **Every member this store serves, in a stable order.**
    ///
    /// The route and stage-time materialisation both enumerate through THIS, so the set of
    /// members a processor finds on disk and the set the browser can fetch cannot diverge —
    /// which is ITEM-31's claim applied to addresses rather than to bytes.
    pub fn member_paths(&self) -> Vec<String> {
        let m = self.member_path();
        let mut out = vec!["zarr.json".to_string(), format!("{m}/zarr.json")];
        if let Some(strings) = &self.strings {
            let off_chunk = self.chunk_elements;
            let val_chunk = super::gathered::values_chunk_bytes_of(&self.structure);
            out.push(format!("{m}/offsets/zarr.json"));
            for g in 0..(self.n + 1).div_ceil(off_chunk) {
                out.push(format!("{m}/offsets/c/{g}"));
            }
            out.push(format!("{m}/values/zarr.json"));
            for g in 0..strings.values.len().div_ceil(val_chunk).max(1) {
                out.push(format!("{m}/values/c/{g}"));
            }
        } else {
            for g in 0..self.chunk_count() {
                out.push(format!("{m}/c/{g}"));
            }
        }
        out
    }

    /// **One member of the gathered store, by its store-relative path.**
    ///
    /// `Ok(None)` means *this store has no such member* — the caller answers 404. It is
    /// never an empty `Ok(Some(vec![]))`: a stored artifact answers 404 for a member it does
    /// not have, and an empty 200 decodes as no data rather than as an error, which is the
    /// blank-surface failure on the wire.
    ///
    /// **Each split member uses ITS OWN geometry** — offsets by ELEMENT, values by BYTE.
    /// Deriving one from the other is right for chunk 0 and wrong after it.
    pub fn member(&self, path: &str) -> Result<Option<Vec<u8>>, AppError> {
        let encode = |v: &Value| -> Result<Vec<u8>, AppError> {
            serde_json::to_vec_pretty(v)
                .map_err(|e| AppError::internal_error(format!("encode zarr.json: {e}")))
        };
        if path == "zarr.json" {
            return Ok(Some(encode(&self.group_zarr_json()?)?));
        }
        let m = self.member_path();
        let Some(rest) = path.strip_prefix(&format!("{m}/")) else {
            return Ok(None);
        };

        let Some(strings) = &self.strings else {
            // ── FLAT: one array under `<member>/` ────────────────────────────────
            if rest == "zarr.json" {
                return Ok(Some(encode(&self.flat_array_zarr_json()?)?));
            }
            let Some(g) = super::gathered::chunk_index(rest) else {
                return Ok(None);
            };
            if g >= self.chunk_count() {
                return Ok(None);
            }
            return Ok(Some(self.chunk(g)?));
        };

        // ── SPLIT: a group holding `offsets` and `values` ────────────────────────
        let off_chunk = self.chunk_elements;
        let val_chunk = super::gathered::values_chunk_bytes_of(&self.structure);
        let off_chunks = (self.n + 1).div_ceil(off_chunk);
        let val_chunks = strings.values.len().div_ceil(val_chunk).max(1);
        let bytes = match rest {
            "zarr.json" => encode(&super::gathered::split_group_zarr_json(&m, self.n))?,
            "offsets/zarr.json" => {
                encode(&super::gathered::split_offsets_zarr_json(self.n, off_chunk))?
            }
            "values/zarr.json" => encode(&super::gathered::split_values_zarr_json(
                strings.values.len(),
                val_chunk,
            ))?,
            p if p.starts_with("offsets/c/") => {
                let Some(g) = super::gathered::chunk_index(p.trim_start_matches("offsets/")) else {
                    return Ok(None);
                };
                if g >= off_chunks {
                    return Ok(None);
                }
                let flat: Vec<u8> = strings
                    .offsets
                    .iter()
                    .flat_map(|o| o.to_le_bytes())
                    .collect();
                super::gathered::slice_chunk(&flat, g, off_chunk, 4)
            }
            p if p.starts_with("values/c/") => {
                let Some(g) = super::gathered::chunk_index(p.trim_start_matches("values/")) else {
                    return Ok(None);
                };
                if g >= val_chunks {
                    return Ok(None);
                }
                super::gathered::slice_chunk(&strings.values, g, val_chunk, 1)
            }
            _ => return Ok(None),
        };
        Ok(Some(bytes))
    }

    /// **This column's whole plane, as the bytes a source of it would contribute** (ITEM-21).
    ///
    /// What an intermediate of a chain hands up. It is assembled through the SAME
    /// [`super::gathered::gather_chunk_multi`] the byte route serves and `materialize` writes,
    /// rather than through a second assembly that would agree today and drift later — the one
    /// property this module has paid for repeatedly. The trailing partial chunk is trimmed to
    /// `n × item`, because `gather_chunk_multi` pads a short final chunk to full width and
    /// those pad bytes are not rows.
    fn into_source_bytes(self) -> Result<SourceBytes, AppError> {
        if let Some(strings) = self.strings {
            return Ok(SourceBytes::Split {
                offsets: strings.offsets,
                values: strings.values,
                n: self.n,
                // Propagated so a filter reading this split source through the chain keeps any
                // resolved vocabulary (C1) — `None` in practice for a split string column.
                levels: self.levels,
                missing_level: self.missing_level,
            });
        }
        let mut bytes = Vec::with_capacity(self.n * self.item);
        for g in 0..self.chunk_count() {
            bytes.extend_from_slice(&super::gathered::gather_chunk_multi(
                g,
                &self.row_plan,
                &self.sources,
                self.item,
                self.chunk_elements,
            )?);
        }
        bytes.truncate(self.n * self.item);
        Ok(SourceBytes::Flat {
            bytes,
            item: self.item,
            n: self.n,
            // The inner node's UNIFIED vocabulary rides up the chain here (C1, INV-13): the outer
            // filter has no member `zarr.json` of its own to read it from, so without this the
            // filtered-integration categorical would serve unified codes with no labels.
            levels: self.levels,
            missing_level: self.missing_level,
        })
    }

    /// One chunk's bytes — the serve path's unit of work.
    pub fn chunk(&self, g: usize) -> Result<Vec<u8>, AppError> {
        super::gathered::gather_chunk_multi(
            g,
            &self.row_plan,
            &self.sources,
            self.item,
            self.chunk_elements,
        )
    }

    /// **The GATHERED size in bytes** — `rows × element width`.
    ///
    /// Not a parent's size, and not the catalog's `stored_bytes` (which is 0 for a gathered
    /// row, since there is no blob). A budget taken from either would be the wrong number:
    /// a source's size describes bytes this column does not serve, and the catalog column
    /// describes bytes that do not exist. This is what the column actually delivers.
    pub fn gathered_size_bytes(&self) -> u64 {
        (self.n as u64) * (self.item as u64)
    }

    /// How many chunks the store holds.
    pub fn chunk_count(&self) -> usize {
        self.n.div_ceil(self.chunk_elements)
    }

    /// **Materialise the whole store under `dest`** — every member [`Self::member_paths`]
    /// names, produced by [`Self::member`], which is the call the byte route serves.
    ///
    /// Returns the bytes written. Enumerating through `member_paths` rather than through a
    /// second, private list is what makes ITEM-31 hold at the ADDRESS level too: a processor
    /// reading `<root>/values/zarr.json` off disk and a browser fetching it over HTTP cannot
    /// find different sets of members, because there is one list.
    pub async fn materialize(&self, dest: &Path) -> Result<u64, AppError> {
        let mut written = 0u64;
        for rel in self.member_paths() {
            let bytes = self.member(&rel)?.ok_or_else(|| {
                // `member_paths` named it and `member` does not serve it: the two disagree,
                // and writing the rest would leave a store that decodes short — the exact
                // quiet failure this path must not produce.
                AppError::internal_error(format!(
                    "materialise: member {rel:?} is enumerated but not served — the member \
                     list and the member producer disagree about this store"
                ))
            })?;
            if bytes.is_empty() {
                return Err(AppError::internal_error(format!(
                    "materialise: member {rel:?} produced no bytes for a {}-row column",
                    self.n
                )));
            }
            let path = dest.join(&rel);
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    AppError::internal_error(format!(
                        "materialise: mkdir {}: {e}",
                        parent.display()
                    ))
                })?;
            }
            written += bytes.len() as u64;
            tokio::fs::write(&path, &bytes)
                .await
                .map_err(|e| AppError::internal_error(format!("materialise: write {rel}: {e}")))?;
        }
        Ok(written)
    }
}

/// **The virtual-dataset MASK, resolved to a per-row keep vector + its `rank` (ITEM-3/4).**
///
/// The mask is a per-source Zarr `bool` member, ONE byte per source row (DEC-1: read it that
/// way, never bit-unpacked), `true` = kept, in the source's OWN row order (DEC-11). Stage B
/// reads it once per `(dataset, mask)` and caches it (`super::masked_rank_cache`, INV-23/E7),
/// because the same mask selects every column of the virtual dataset and re-reading it per
/// column is the amplification ITEM-4 forbids.
///
/// The **`rank`** is the exclusive prefix-sum of `keep`: `rank[i]` = how many rows before `i`
/// are kept = the OUTPUT position a kept row `i` lands at. It is precomputed here rather than
/// re-walked per read so the future per-column sparse path (ITEM-5) can map a source row to its
/// output position in O(1) — `output = rank[source_row]` — without materialising the whole
/// filtered plan. The DENSE serve path (ITEM-3) does not need `rank` explicitly: filtering the
/// row plan IN ORDER already lands each kept row at its compacted position (output positions
/// come out ascending for free — sources ascending, keep monotone). `rank` and the in-order
/// filter are two readings of one fact and `MaskPlan::apply` uses the second; `rank` is
/// carried so the two never drift and the column path reuses the same cached object.
#[derive(Debug, Clone)]
pub struct MaskPlan {
    /// Per source row: kept (`true`) or dropped (`false`).
    pub keep: Vec<bool>,
    /// Exclusive prefix-sum of `keep` — `rank[i]` is the output position of source row `i`
    /// (meaningful only when `keep[i]`). Length equals `keep`.
    pub rank: Vec<u32>,
    /// Kept rows — the post-mask output length `N_kept`.
    pub n_kept: usize,
}

impl MaskPlan {
    /// Build the plan (and its `rank`) from a decoded keep vector. The ONE place the prefix-sum
    /// is computed, so the cached object every column shares is the same arithmetic.
    pub fn from_keep(keep: Vec<bool>) -> Self {
        let mut rank = Vec::with_capacity(keep.len());
        let mut acc = 0u32;
        for &k in &keep {
            rank.push(acc);
            if k {
                acc += 1;
            }
        }
        MaskPlan {
            keep,
            rank,
            n_kept: acc as usize,
        }
    }

    /// Heap the cache budgets: the keep byte-vector plus the `u32` rank.
    pub fn footprint_bytes(&self) -> usize {
        self.keep.len() + self.rank.len() * std::mem::size_of::<u32>()
    }

    /// **Filter a pre-mask row plan to the kept rows, in output order (ITEM-3).**
    ///
    /// `plan[i]` is the pre-mask output row and `keep[i]` says whether it survives; the kept
    /// entries are pushed in order, so each lands at its compacted (rank) position and the
    /// result is ascending by construction — filter + rank + segment-offset in one pass. The
    /// mask is indexed in the SAME order as the pre-mask plan (source order for the lone-source
    /// filter case, §3.4/DEC-11), which the caller asserts by refusing a length disagreement.
    fn apply(&self, plan: &[(usize, usize)]) -> Vec<(usize, usize)> {
        plan.iter()
            .zip(self.keep.iter())
            .filter_map(|(rp, &k)| k.then_some(*rp))
            .collect()
    }
}

/// **The bytes ONE source contributes** — read off a stored blob, or produced by resolving a
/// source that is itself gathered (ITEM-21, a CHAIN).
///
/// It carries the width and the row count beside the bytes because both are FACTS about the
/// buffer rather than about the declaration that named it: a chained source's element width
/// is whatever its own gather produced, and re-deriving it from the outer column's
/// declaration is the assumption the width regression was made of.
#[derive(Clone)]
pub enum SourceBytes {
    /// A fixed-width column: `n` elements of `item` bytes each.
    Flat {
        bytes: Vec<u8>,
        item: usize,
        n: usize,
        /// The categorical vocabulary this source resolved to, verbatim, and the entry meaning
        /// "not in this vocabulary". Carried so a column reading THROUGH this chained source (a
        /// filter over a previously-integrated VD) keeps the UNIFIED levels the inner node
        /// resolved — otherwise the outer node serves the right unified CODES with no `levels`,
        /// "numbers where labels belong" (C1, INV-13/INV-6). `None` for a numeric column, or a
        /// categorical whose source declared none.
        levels: Option<Value>,
        missing_level: Option<Value>,
    },
    /// A SPLIT string column: `n + 1` offsets over a values buffer.
    Split {
        offsets: Vec<u32>,
        values: Vec<u8>,
        n: usize,
        /// See [`Self::Flat::levels`]. A split string column is never a fused categorical, so
        /// these are `None` in practice; carried on both arms so the chain propagates one shape.
        levels: Option<Value>,
        missing_level: Option<Value>,
    },
}

impl SourceBytes {
    /// Rows this source contributes — cross-checked against the alignment's own `n_rows`.
    fn n(&self) -> usize {
        match self {
            Self::Flat { n, .. } | Self::Split { n, .. } => *n,
        }
    }

    /// **The categorical vocabulary a chained source resolved to** — `(levels, missing_level)`.
    ///
    /// The outer node that reads this source through a filter propagates these onto its OWN
    /// resolved `zarr.json` (C1): the inner (integration) node already fused the sources into one
    /// unified vocabulary, and discarding it here is what served unified codes with no labels.
    fn levels(&self) -> (Option<&Value>, Option<&Value>) {
        match self {
            Self::Flat {
                levels,
                missing_level,
                ..
            }
            | Self::Split {
                levels,
                missing_level,
                ..
            } => (levels.as_ref(), missing_level.as_ref()),
        }
    }

    fn flat(&self, artifact_id: Uuid) -> Result<(&[u8], usize), AppError> {
        match self {
            Self::Flat { bytes, item, .. } => Ok((bytes, *item)),
            Self::Split { .. } => Err(AppError::bad_request(
                "GATHER_CHAIN_SHAPE_MISMATCH",
                format!(
                    "chained source {artifact_id} resolves to a SPLIT string column, but the \
                     column reading through it declares a fixed-width element type. The two \
                     shapes have different member layouts, so gathering one as the other reads \
                     an offsets array as data"
                ),
            )),
        }
    }

    fn split(&self, artifact_id: Uuid) -> Result<(&[u32], &[u8]), AppError> {
        match self {
            Self::Split {
                offsets, values, ..
            } => Ok((offsets, values)),
            Self::Flat { .. } => Err(AppError::bad_request(
                "GATHER_CHAIN_SHAPE_MISMATCH",
                format!(
                    "chained source {artifact_id} resolves to a fixed-width column, but the \
                     column reading through it declares `utf8`, whose bytes are an offsets \
                     member and a values member. There is no offsets array to read"
                ),
            )),
        }
    }
}

/// The intermediates of a chain, already resolved — keyed by artifact id.
type ChainBuffers = std::collections::HashMap<Uuid, SourceBytes>;

/// One node of a chain: a gathered artifact and the declaration that makes it one.
struct ChainNode {
    id: Uuid,
    structure: serde_json::Value,
    /// `(named id, content address)` for every input this node's resolution reads — its
    /// alignment and its leaf sources. See [`resolution_key`].
    inputs: Vec<(Uuid, String)>,
}

/// **A cap on how many gathered artifacts one read may touch**, independent of depth.
///
/// Depth alone does not bound the WORK: a chain 8 deep whose every level fans out over many
/// gathered sources is still a tree, and each node costs a catalog read plus a full decode of
/// every source it names. This is the second bound, and it exists for the same reason
/// [`super::gathered::MAX_CHAIN_DEPTH`] does — not because the graph is expected to reach it,
/// but so that an unexpected shape is a named refusal rather than a request handler that
/// never returns.
const MAX_CHAIN_NODES: usize = 64;

/// **Walk the chain, metadata-only, and return its nodes deepest-first (ITEM-21).**
///
/// This is the port the `CHAIN_RESOLUTION_UNPORTED` refusal stood in for. What changed since
/// that refusal was written is the recipe: a source is a DATASET now, resolved to an artifact
/// by [`super::gathered::GatheredFrom::artifact_for_dataset`], and that artifact may itself
/// carry a recipe instead of an `object_key`. So the walk is over ARTIFACTS, and what it
/// returns is a resolution ORDER rather than a single composed vector.
///
/// ## Why an order rather than one composed row vector
///
/// [`super::gathered::compose_rows`] composes `output row -> source row` into
/// `output row -> LEAF row`, and that is total and associative — but it is the SINGLE-SOURCE
/// case. Under the segment model a row resolves to `(source, row within that source)`, and an
/// intermediate resolves each of ITS rows to a different one of ITS sources; the composition
/// of two such maps is a map into a UNION of leaves, not a `Vec<u32>` into one. Flattening it
/// that way is expressible, but it would also have to compose the per-source LEVEL LOOKUPS
/// and the per-source element WIDTHS, because a fused categorical's codes are per-source and
/// an intermediate has already remapped its own into ITS unified vocabulary. Two vocabularies
/// composed wrongly is CRITICAL-2 again, with the right row count and the wrong labels.
///
/// So the chain is resolved BOTTOM-UP instead: each intermediate is resolved by the same code
/// that resolves the outer column, and its output is handed up as ordinary source bytes. That
/// is not a workaround — it is INV-3 applied on this side of the wire. The design's central
/// claim is that a gathered artifact is indistinguishable from a stored one; if that holds for
/// the client it holds for the gather, and an intermediate's bytes ARE the bytes a stored
/// source would have had.
///
/// ## Iterative, and the three bounds
///
/// * **Acyclic by construction** — an alignment names sources that already EXIST, so every
///   edge points backwards in creation order, and artifacts are IMMUTABLE, so an edge can
///   never be re-pointed forwards. A cycle is unconstructible.
/// * **A path-based visited check** — so that IF a cycle ever became constructible, the
///   failure is a named refusal rather than a hang. Path-based rather than global, because a
///   node legitimately reachable from two parents (a diamond) is not a cycle; the global
///   `resolved` memo beside it is what keeps a diamond from re-expanding.
/// * **[`super::gathered::MAX_CHAIN_DEPTH`] and [`MAX_CHAIN_NODES`]** — depth and total work.
///
/// Written with an explicit stack rather than as async recursion, deliberately: a boxed
/// recursive future would put an unbounded native stack behind the very bound this enforces.
///
/// ## Every LEAF digest is verified HERE, before one byte is fetched
///
/// The precheck landing on the leaf is the whole point (ITEM-20): an intermediate has no bytes
/// of its own, so checking one verifies something the gather never reads. It is hoisted out of
/// the per-node resolution and into this walk for a reason the single-level shape did not
/// have: with a chain, node *k*'s BYTES would otherwise be fetched before node *k+1*'s digests
/// were checked, and "refused before a single source byte is fetched" would hold per node
/// while failing for the read.
///
/// **An INTERMEDIATE is not asked for a `key_sequence_digest`, and that is not a relaxation.**
/// It has none to give — the creator mints a gathered row with neither
/// `structure.key_sequence_digest` nor `structure.aligned_to` (`virtual_dataset.rs`) — so
/// demanding one would refuse every chain by construction, which is where this behavior already
/// spent a round. It is also not needed: the recipe names an artifact ID, artifacts are
/// immutable, and so are every recipe, alignment and artifact id reachable below it. The ONLY
/// thing that can change under a chain is a LEAF's bytes, and that is exactly what the leaf
/// digests pin. The intermediate's SHAPE is cross-checked separately, against the outer
/// alignment's own declared `n_rows` for that source ([`resolve_node`]).
async fn plan_chain(
    pool: &SqlitePool,
    self_artifact_id: Uuid,
    structure: &serde_json::Value,
) -> Result<Vec<ChainNode>, AppError> {
    struct Frame {
        id: Uuid,
        structure: serde_json::Value,
        children: Vec<(Uuid, serde_json::Value)>,
        next: usize,
        /// The CONTENT addresses this node's resolution depends on: its alignment's blob and
        /// every leaf source's blob, each paired with the id that named it. Collected in the
        /// walk that already reads every one of those rows, rather than by a second traversal
        /// — two walks that agree today are two walks that will disagree later.
        inputs: Vec<(Uuid, String)>,
    }

    let mut frames: Vec<Frame> = Vec::new();
    let mut order: Vec<ChainNode> = Vec::new();
    let mut resolved: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    let mut budget = MAX_CHAIN_NODES;

    // Expand ONE gathered node: parse its recipe, load its alignment (if any), and split its
    // sources into leaves (digest-verified here and now) and gathered children (walked next).
    async fn expand(
        pool: &SqlitePool,
        id: Uuid,
        structure: serde_json::Value,
    ) -> Result<Frame, AppError> {
        let recipe = super::gathered::GatheredFrom::parse(&structure)?;
        let repo = CatalogRepository::new(pool.clone());
        let mut children = Vec::new();
        let mut inputs: Vec<(Uuid, String)> = Vec::new();

        // **The per-source (dataset, pinned-digest) list — from the alignment when there is
        // one, from the recipe itself for a single-source MASK recipe (§3.4, ITEM-3).** An
        // integration's sources and their pinned digests are the alignment's authority
        // (INV-3); a lone-source filter has no alignment and no cross-source join, so its one
        // source is named by the recipe and pinned by IMMUTABILITY — the recipe names an
        // immutable `artifact_id`, so its byte sequence cannot drift under it (the same
        // guarantee `plan_chain` leans on for an intermediate).
        let per_source: Vec<(String, Option<String>)> = match recipe.alignment_artifact_id {
            Some(_) => {
                let (plan, alignment_hash) = load_alignment_plan(pool, id, &recipe).await?;
                // `load_alignment_plan` refused a null alignment, so this is `Some`.
                inputs.push((recipe.require_alignment()?, alignment_hash));
                plan.sources
                    .iter()
                    .map(|s| (s.dataset_id.clone(), s.key_sequence_digest.clone()))
                    .collect()
            }
            None => recipe
                .sources
                .iter()
                .map(|s| (s.dataset_id.clone(), None))
                .collect(),
        };

        // **The MASK rides the resolution key too (ITEM-4 / INV-31).** Its id is already inside
        // `structure.gathered_from.mask_artifact_id`, which `resolution_key` hashes, so two VDs
        // differing only by mask key differently on that alone. Feeding its `content_hash` here
        // as well makes the address CONTENT-based like every leaf's — belt and braces for the
        // (immutable) mask, and it pins the mask into the walk that discovers a deleted one.
        if let Some(mask_id) = recipe.mask_artifact_id {
            match repo.get_any_status(mask_id).await? {
                Some(row) => {
                    inputs.push((mask_id, format!("{}|{}", row.content_hash, row.structure)))
                }
                None => {
                    return Err(mark_unresolvable_then_refuse(
                        pool,
                        id,
                        &format!("mask {mask_id}"),
                        AppError::bad_request(
                            "ARTIFACT_UNRESOLVABLE",
                            format!(
                                "this column's rows are selected by mask {mask_id}, which no \
                                 longer exists — the mask was deleted out from under the virtual \
                                 dataset. Naming it is the point (INV-9): serving the unmasked \
                                 rows would silently un-filter the dataset."
                            ),
                        ),
                    )
                    .await)
                }
            }
        }

        for (dataset_id, pinned_digest) in per_source.iter() {
            let artifact_id = recipe.artifact_for_dataset(dataset_id)?;
            let row = match repo.get_any_status(artifact_id).await? {
                Some(row) => row,
                // DISCOVERY POINT 1 — a source artifact is gone. Recorded on the node that
                // NAMES it, which in a chain is the intermediate rather than the artifact the
                // request asked for: the row whose readability actually changed is the one
                // holding the dangling reference, and marking the outer one instead would
                // condemn a row whose own declaration is intact.
                None => {
                    return Err(mark_unresolvable_then_refuse(
                        pool,
                        id,
                        &format!("dataset {dataset_id:?} (artifact {artifact_id})"),
                        AppError::bad_request(
                            "ARTIFACT_UNRESOLVABLE",
                            format!(
                                "this column reads through dataset {dataset_id:?}, whose artifact \
                                 {artifact_id} no longer exists. INV-9: the refusal names the \
                                 source that went missing rather than rendering short."
                            ),
                        ),
                    )
                    .await)
                }
            };
            if row.object_key.is_none() {
                // A GATHERED source — the chain. Its own leaves are verified when it is
                // expanded in turn.
                children.push((artifact_id, row.structure));
                continue;
            }
            // **THE DIGEST PRECHECK IS AN ALIGNMENT-PATH GUARD (INV-5).** It exists because an
            // alignment's row vectors are POSITIONAL: they index a source by row NUMBER, so a
            // source whose key sequence changed under the alignment would be read at the right
            // count and the wrong rows. A lone-source MASK recipe carries no such positional
            // vector — the recipe names the source's immutable, content-addressed `artifact_id`
            // directly, so its byte sequence cannot drift under it (the same guarantee
            // `plan_chain` leans on to NOT demand a digest from an intermediate). Demanding a
            // pin here would refuse every filter VD, since a lone source has no alignment to
            // record one. So the check runs on the alignment path and is skipped on the
            // no-alignment one — its absence is not a relaxation, it is a different guard.
            if recipe.alignment_artifact_id.is_some() {
                // **THE IDENTITY LIVES IN ONE OF TWO FIELDS.** The writer emits
                // `structure.key_sequence_digest` only on the artifact that CARRIES an axis's
                // keys; a table merely living on that axis declares `structure.aligned_to`, the
                // SAME digest asserted from the other side.
                let actual = row
                    .structure
                    .get("key_sequence_digest")
                    .or_else(|| row.structure.get("aligned_to"))
                    .and_then(|v| v.as_str())
                    .filter(|d| !d.is_empty());
                super::gathered::verify_leaf_digest(
                    &format!("{artifact_id} (dataset {dataset_id:?})"),
                    pinned_digest.as_deref(),
                    actual,
                )?;
            }
            // The leaf's CONTENT address, recorded for [`resolution_key`]. Its `structure` is
            // hashed in beside it because the declaration — dtype, `n`, the declared digest —
            // is read as control plane and is not covered by the blob's own hash, so a row
            // re-declared over the same bytes must not hit a warm entry.
            inputs.push((
                artifact_id,
                format!("{}|{}", row.content_hash, row.structure),
            ));
        }
        Ok(Frame {
            id,
            structure,
            children,
            next: 0,
            inputs,
        })
    }

    frames.push(expand(pool, self_artifact_id, structure.clone()).await?);
    loop {
        let top = frames
            .last_mut()
            .expect("the loop breaks when the last frame pops");
        if top.next < top.children.len() {
            let (child_id, child_structure) = top.children[top.next].clone();
            top.next += 1;
            if let Some(at) = frames.iter().position(|f| f.id == child_id) {
                let path: Vec<String> = frames
                    .iter()
                    .skip(at)
                    .map(|f| f.id.to_string())
                    .chain(std::iter::once(child_id.to_string()))
                    .collect();
                return Err(AppError::bad_request(
                    "GATHER_CHAIN_CYCLE",
                    format!(
                        "the chain revisits artifact {child_id}, so it is a CYCLE: {}. This is \
                         supposed to be unconstructible — an alignment names sources that \
                         already exist and artifacts are immutable — so reaching here means \
                         some path now rewrites ids. Refusing by name rather than resolving \
                         forever is the point of the check.",
                        path.join(" -> ")
                    ),
                ));
            }
            if resolved.contains(&child_id) {
                // A DIAMOND, not a cycle: two parents naming one intermediate. It is already
                // in `order`, so it must not be expanded (or emitted) twice.
                continue;
            }
            if frames.len() + 1 > super::gathered::MAX_CHAIN_DEPTH {
                return Err(AppError::bad_request(
                    "GATHER_CHAIN_TOO_DEEP",
                    format!(
                        "resolving artifact {self_artifact_id} reaches a chain deeper than \
                         {} levels at artifact {child_id}. Chains deeper than two are not an \
                         expected shape; the bound exists so an unexpected one is a refusal \
                         with a message rather than a handler that exhausts a resource.",
                        super::gathered::MAX_CHAIN_DEPTH
                    ),
                ));
            }
            budget = budget.checked_sub(1).unwrap_or(0);
            if budget == 0 {
                return Err(AppError::bad_request(
                    "GATHER_CHAIN_TOO_WIDE",
                    format!(
                        "resolving artifact {self_artifact_id} would touch more than \
                         {MAX_CHAIN_NODES} gathered artifacts. Depth alone does not bound the \
                         work — each node decodes every source it names — so the total is \
                         bounded too."
                    ),
                ));
            }
            frames.push(expand(pool, child_id, child_structure).await?);
        } else {
            let f = frames.pop().expect("checked non-empty");
            resolved.insert(f.id);
            order.push(ChainNode {
                id: f.id,
                structure: f.structure,
                inputs: f.inputs,
            });
            if frames.is_empty() {
                break;
            }
        }
    }
    Ok(order)
}

/// The store is a PARAMETER rather than the process-global one, and that is not stylistic:
/// reaching for `get_object_store()` here made this function unusable outside a booted
/// server, so the only way to exercise it was through HTTP — which is exactly the coupling
/// that lets a "shared" function quietly become the serve path's private one.
///
/// **Chained sources resolve BOTTOM-UP** (ITEM-21): [`plan_chain`] verifies every leaf digest
/// and returns the chain deepest-first, then each intermediate is resolved by the SAME
/// [`resolve_node`] the outer column uses and handed up as ordinary source bytes. One code
/// path, so a chain and a direct read cannot disagree about what a column's bytes are — which
/// is the property `materialize` and the byte route already share for the single-level case.
pub async fn resolve(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    // The GATHERED artifact being read. Needed so the two discovery points can RECORD the
    // condition they already refuse by name (ITEM-30's detector), rather than leaving a
    // state with readers and no writer.
    self_artifact_id: Uuid,
    structure: &serde_json::Value,
) -> Result<ResolvedGather, AppError> {
    let order = plan_chain(pool, self_artifact_id, structure).await?;
    resolve_from_order(pool, store, self_artifact_id, structure, &order).await
}

/// **The BYTE half of a resolution** — everything after the metadata walk.
///
/// Split out of [`resolve`] so [`resolve_shared`] can run the walk (which verifies) on every
/// request while skipping this (which fetches and decodes) on a cache hit. That split IS the
/// correctness boundary: the walk is what discovers a deleted or re-declared source, and a
/// cache that skipped it would serve a column whose sources no longer support it.
async fn resolve_from_order(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    self_artifact_id: Uuid,
    structure: &serde_json::Value,
    order: &[ChainNode],
) -> Result<ResolvedGather, AppError> {
    // Deepest-first, and the artifact the request asked for is LAST — so every intermediate
    // it reads through is already a buffer by the time it resolves.
    let mut chain: ChainBuffers = ChainBuffers::new();
    let (last, intermediates) = order.split_last().expect("the walk always emits the root");
    debug_assert_eq!(last.id, self_artifact_id);
    for node in intermediates {
        let resolved = resolve_node(pool, store, node.id, &node.structure, &chain).await?;
        chain.insert(node.id, resolved.into_source_bytes()?);
    }
    resolve_node(pool, store, self_artifact_id, structure, &chain).await
}

/// **The cache key for one resolution: every input's CONTENT address, plus the column's own
/// declaration.**
///
/// Two resolutions share a key exactly when they would read the same bytes through the same
/// declaration. Each part is load-bearing:
///
/// * **the gathered artifact's own `structure`** — it carries the recipe (which alignment,
///   which member, which artifact each dataset resolves to) AND the output geometry (`dtype`,
///   `n`, `chunk_elements`). Omitting it is how the definition hash, which covers none of the
///   geometry and names DATASETS rather than the ARTIFACTS behind them, would have let two
///   different columns share an entry.
/// * **each node's inputs, in walk order** — `(id, content_hash|structure)` for the alignment
///   and every leaf. Content-addressed, so identical keys mean identical bytes; and the
///   leaf's `structure` rides along because the digest the walk verifies lives there rather
///   than in the blob.
/// * **the chain SHAPE** — node ids in resolution order, so a chain that acquires or loses a
///   level cannot reuse the old shape's entry.
///
/// Not the artifact id alone: an id is stable across everything BELOW it changing, which is
/// the whole failure this avoids.
fn resolution_key(
    self_artifact_id: Uuid,
    structure: &serde_json::Value,
    order: &[ChainNode],
) -> String {
    use sha2::{Digest, Sha256};
    // LENGTH-PREFIXED parts, so `("ab","c")` and `("a","bc")` cannot collide — the same
    // discipline `definition_content_hash` follows, for the same reason.
    fn feed(h: &mut Sha256, s: &str) {
        h.update((s.len() as u64).to_le_bytes());
        h.update(s.as_bytes());
    }
    let mut h = Sha256::new();
    feed(&mut h, &self_artifact_id.to_string());
    feed(&mut h, &structure.to_string());
    for node in order {
        feed(&mut h, &node.id.to_string());
        for (id, address) in &node.inputs {
            feed(&mut h, &id.to_string());
            feed(&mut h, address);
        }
        // A terminator per node, so two different groupings of the same inputs across nodes
        // cannot concatenate into the same digest.
        h.update([0xffu8]);
    }
    hex::encode(h.finalize())
}

/// **[`resolve`], with the byte half served from a process-wide cache when the inputs are
/// unchanged.**
///
/// This is what the byte route calls. The difference from [`resolve`] is ONE thing and it is
/// deliberate: the metadata walk still runs, every time. See [`super::gathered::ResolutionCache`]
/// for the ordering argument, and `gather_scale_test` for the measurement that motivated it
/// (a whole-column scan read 123x the bytes one pass needs).
///
/// Returns an `Arc` because the point is that concurrent readers of one column SHARE the
/// resolved buffers rather than each holding their own copy. Measured: 8 CONCURRENT
/// uncached resolutions of one 500k-row column grew the resident set by 141 MiB — 9.3x the
/// column per reader. Sharing is what turns that into one copy, so the cache reduces peak
/// memory under concurrency rather than adding to it; what it adds is bounded by the budget
/// and paid only across DISTINCT columns.
pub async fn resolve_shared(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    self_artifact_id: Uuid,
    structure: &serde_json::Value,
    cache: &super::gathered::ResolutionCache<ResolvedGather>,
) -> Result<std::sync::Arc<ResolvedGather>, AppError> {
    // ALWAYS, hit or miss: this is what verifies every leaf digest and what discovers a
    // deleted source (recording `unresolvable` on the row that names it).
    let order = plan_chain(pool, self_artifact_id, structure).await?;
    let key = resolution_key(self_artifact_id, structure, &order);
    if let Some(warm) = cache.get(&key) {
        return Ok(warm);
    }
    let resolved = std::sync::Arc::new(
        resolve_from_order(pool, store, self_artifact_id, structure, &order).await?,
    );
    cache.put(
        &key,
        std::sync::Arc::clone(&resolved),
        resolved.footprint_bytes(),
    );
    Ok(resolved)
}

/// **A gathered column's `structure`, RESOLVED to the post-mask kept count `n` (ITEM-9 /
/// INV-17).**
///
/// At creation the VD writer stamps `n` = the SOURCE row count (it cannot know `N_kept` without
/// reading the mask); the serve path resolves it here, from the SAME resolution that produces
/// the chunks. `synthetic_zarr_json`/`gathered_group_zarr_json` read `structure.n` for the
/// array shape and copy `n`/`columns[0]` into the group node's `attributes.cyto`, so all three
/// spellings — top-level `n`, `columns[0].n`, `columns[0].shape[0]` — are set to `n_kept` in
/// lockstep. Leaving any one at the source count is the drift INV-17 forbids: the array node
/// would declare `N_kept` while the group node's declaration still claimed the source count.
fn resolved_structure_with_n(structure: &serde_json::Value, n_kept: usize) -> serde_json::Value {
    let mut s = structure.clone();
    let nv = Value::from(n_kept as u64);
    if let Some(obj) = s.as_object_mut() {
        obj.insert("n".into(), nv.clone());
        if let Some(col) = obj
            .get_mut("columns")
            .and_then(Value::as_array_mut)
            .and_then(|a| a.first_mut())
            .and_then(Value::as_object_mut)
        {
            if col.contains_key("n") {
                col.insert("n".into(), nv.clone());
            }
            if let Some(shape) = col.get_mut("shape").and_then(Value::as_array_mut) {
                if let Some(first) = shape.first_mut() {
                    *first = nv;
                }
            }
        }
    }
    s
}

/// **Read a virtual dataset's MASK to its cached [`MaskPlan`] (ITEM-3/4, INV-23/E7).**
///
/// The mask is a Zarr `bool` member — ONE byte per source row (DEC-1: never bit-unpacked),
/// `true` = kept — read through the SAME `gather_decode` seam every other member goes through
/// (its `item_size("bool") == 1`, so the decoded buffer is one byte per row). The member path
/// is the mask store's own `columns[0].path` (a `metadata-column`'s single member, defaulting
/// to `values`).
///
/// Keyed on `mask_id | content_hash` in the process-wide [`super::masked_rank_cache`], so the
/// prefix-sum is built ONCE per `(dataset, mask)` and every column of the VD reuses it. The
/// mask's existence was already checked in `plan_chain::expand` (it fed the resolution key), so
/// a `None` here is a race, not the deleted-mask discovery point.
async fn mask_plan(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    mask_id: Uuid,
) -> Result<std::sync::Arc<MaskPlan>, AppError> {
    let repo = CatalogRepository::new(pool.clone());
    let row = repo.get_any_status(mask_id).await?.ok_or_else(|| {
        AppError::bad_request(
            "ARTIFACT_UNRESOLVABLE",
            format!(
                "mask {mask_id} no longer exists — the virtual dataset's row selection is gone"
            ),
        )
    })?;
    let key = format!("{mask_id}|{}", row.content_hash);
    let cache = super::masked_rank_cache();
    if let Some(warm) = cache.get(&key) {
        return Ok(warm);
    }
    let member = super::gathered::gathered_member_path(&row.structure);
    let bytes = read_member_element_bytes(pool, store, mask_id, &member).await?;
    // ONE byte per row, `!= 0` = kept. DEC-1 is explicit that this is a `bool` member and NOT a
    // packed bitset, so there is no bit-unpack step and the reader and the producer share one
    // layout.
    let keep: Vec<bool> = bytes.iter().map(|&b| b != 0).collect();
    let plan = std::sync::Arc::new(MaskPlan::from_keep(keep));
    cache.put(&key, std::sync::Arc::clone(&plan), plan.footprint_bytes());
    Ok(plan)
}

/// **The lone-source read: identity plan over one source, then the mask (ITEM-3/6/8/9/15).**
///
/// No alignment ⇒ no join ⇒ the pre-mask output row `i` is simply source row `i` (INV-11: the
/// identity read is byte-equivalent to reading the source directly). When the recipe names a
/// mask, that plan is FILTERED to the kept rows in order — filter + rank + segment-offset in
/// one pass (§11.1i) — and the served `zarr.json` is resolved to `N_kept` (INV-17). Absence of
/// a mask is the identity fast path: the plan is untouched and the output is the source's own
/// bytes.
///
/// The gather that follows is the SAME assembly the aligned path uses — `gather_chunk_multi`
/// for a fixed-width column, `gather_split_strings` for a `utf8` one — so a masked read is
/// shape-invariant with an unmasked one (INV-25): only the plan's length and contents differ.
async fn resolve_single_source_node(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    self_artifact_id: Uuid,
    structure: &serde_json::Value,
    recipe: &super::gathered::GatheredFrom,
    chain: &ChainBuffers,
) -> Result<ResolvedGather, AppError> {
    use super::gathered;

    // `parse` guarantees `sources >= 2 ⇒ alignment`, so a no-alignment recipe has exactly one
    // source; assert it rather than index blindly — a hand-built 0/2-source no-alignment recipe
    // is refused by name, not served from a wrong slot.
    if recipe.sources.len() != 1 {
        return Err(AppError::bad_request(
            "GATHER_RECIPE_INVALID",
            format!(
                "a recipe with no alignment must have exactly ONE source (a lone-source filter \
                 or identity read); this one has {}. Two or more sources join through an \
                 alignment (INV-3).",
                recipe.sources.len()
            ),
        ));
    }
    let source = &recipe.sources[0];
    let artifact_id = source.artifact_id;

    let declared_dtype = structure
        .get("data_type")
        .and_then(|v| v.as_str())
        .unwrap_or("float32");
    let is_split = declared_dtype == "utf8";
    let item = if is_split {
        1
    } else {
        gathered::item_size(declared_dtype)?
    };

    // ── the ONE source's bytes: a chained VD-on-a-VD (INV-3, resolved bottom-up) or a leaf ──
    let chained = chain.get(&artifact_id);
    let (n_src, mut sources, strings_src): (usize, Vec<Vec<u8>>, Option<(Vec<u32>, Vec<u8>)>) =
        if is_split {
            let (offsets, values) = if let Some(buf) = chained {
                let (o, v) = buf.split(artifact_id)?;
                (o.to_vec(), v.to_vec())
            } else {
                let offsets = read_numeric_member(
                    pool,
                    store,
                    artifact_id,
                    &format!("{}/offsets", recipe.column_selector),
                )
                .await?
                .into_iter()
                .map(|v| v as u32)
                .collect::<Vec<u32>>();
                let values = read_member_element_bytes(
                    pool,
                    store,
                    artifact_id,
                    &format!("{}/values", recipe.column_selector),
                )
                .await?;
                (offsets, values)
            };
            // `n+1` offsets over `n` rows; an empty offsets member is a malformed source.
            let n = offsets.len().checked_sub(1).ok_or_else(|| {
                AppError::bad_request(
                    "GATHER_RECIPE_INVALID",
                    format!(
                        "source {artifact_id} member {:?}/offsets is empty — a split string \
                         column declares n+1 offsets over n rows",
                        recipe.column_selector
                    ),
                )
            })?;
            (n, Vec::new(), Some((offsets, values)))
        } else {
            let bytes = if let Some(buf) = chained {
                let (b, _w) = buf.flat(artifact_id)?;
                b.to_vec()
            } else {
                read_member_element_bytes(pool, store, artifact_id, &recipe.column_selector).await?
            };
            if item == 0 || bytes.len() % item != 0 {
                return Err(AppError::bad_request(
                    "GATHER_WIDTH_UNCONVERTIBLE",
                    format!(
                        "source {artifact_id} holds {} byte(s), which is not a whole number of \
                         {item}-byte {declared_dtype} elements",
                        bytes.len()
                    ),
                ));
            }
            let n = bytes.len() / item;
            (n, vec![bytes], None)
        };

    // ── the identity plan, then the mask (filter + rank + segment-offset in one in-order pass) ──
    let base_plan: Vec<(usize, usize)> = (0..n_src).map(|r| (0, r)).collect();
    let (row_plan, n_out) = match recipe.mask_artifact_id {
        None => (base_plan, n_src),
        Some(mask_id) => {
            let mp = mask_plan(pool, store, mask_id).await?;
            if mp.keep.len() != n_src {
                return Err(AppError::bad_request(
                    "GATHER_MASK_LENGTH_MISMATCH",
                    format!(
                        "mask {mask_id} selects {} row(s) but source {artifact_id} has {n_src} — \
                         the mask is per-source in the source's own order (DEC-11), so a length \
                         disagreement means the mask was computed against a different row \
                         sequence and a positional filter would drop the wrong rows (INV-5).",
                        mp.keep.len()
                    ),
                ));
            }
            let kept = mp.apply(&base_plan);
            let n = kept.len();
            (kept, n)
        }
    };

    // A split column's members are gathered over the (possibly filtered) plan — offsets
    // REBUILT to index the compacted values (INV-18), never byte-copied.
    let strings = match strings_src {
        Some((offsets, values)) => Some(gathered::gather_split_strings(
            &row_plan,
            &[(offsets, values)],
        )?),
        None => None,
    };

    // A lone-source categorical's levels are its OWN — the filter does not remap (no unified
    // vocabulary without an alignment). Read them off the source member's `zarr.json` so the
    // resolved declaration carries labels, not bare integers (best-effort: a numeric column has
    // none).
    //
    // A CHAINED source (a filter over a previously-INTEGRATED VD, the sanctioned
    // "filtered integration = chaining" flow) has no member `zarr.json` of its own — but the
    // inner integration node ALREADY resolved the unified vocabulary and carried it up on the
    // chained buffer. Propagate THAT rather than dropping to `(None, None)`: discarding it here
    // is C1 — the outer filter serving correct unified CODES with no `levels`, "numbers where
    // labels belong" (INV-13/INV-6).
    let (levels, missing_level) = if let Some(buf) = chained {
        let (l, m) = buf.levels();
        (l.cloned(), m.cloned())
    } else {
        let meta = super::data_api::read_member_bytes(
            pool,
            store,
            artifact_id,
            &format!("{}/zarr.json", recipe.column_selector),
        )
        .await
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        let at = |key: &str| {
            meta.as_ref()
                .and_then(|m| m.pointer(&format!("/attributes/cyto/{key}")))
                .cloned()
                .filter(|v| !v.is_null())
        };
        (at("levels"), at("missing_level"))
    };

    let resolved_structure = resolved_structure_with_n(structure, n_out);
    let chunk_elements = gathered::chunk_elements_of(&resolved_structure);
    // Free the flat buffer we do not use for a split column (parity with the aligned path,
    // whose `sources` stays empty for a split read).
    if is_split {
        sources.clear();
    }
    let _ = self_artifact_id; // symmetry with `resolve_node`; discovery points live in `expand`.
    Ok(ResolvedGather {
        row_plan,
        sources,
        strings,
        levels,
        missing_level,
        item,
        n: n_out,
        chunk_elements,
        structure: resolved_structure,
    })
}

/// Resolve ONE gathered artifact, with any chained sources already materialised in `chain`.
async fn resolve_node(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    self_artifact_id: Uuid,
    structure: &serde_json::Value,
    chain: &ChainBuffers,
) -> Result<ResolvedGather, AppError> {
    use super::gathered;

    let recipe_for_key = gathered::GatheredFrom::parse(structure)?;

    // ── SINGLE-SOURCE MASKED / IDENTITY READ (ITEM-3/6/8/9/15) ─────────────────────────
    //
    // A recipe with NO alignment is a lone source read through a mask (a filter VD) or, with
    // no mask either, the identity read of that lone source (§11.1b — a real dataset is the
    // identity case, served through the SAME entry point). It has no join to resolve — that is
    // exactly what having no alignment MEANS — so it takes a separate, shorter path rather than
    // the segment/vector machinery below, which exists only to resolve a cross-source join.
    if recipe_for_key.alignment_artifact_id.is_none() {
        return resolve_single_source_node(
            pool,
            store,
            self_artifact_id,
            structure,
            &recipe_for_key,
            chain,
        )
        .await;
    }
    // A mask never co-occurs with an alignment in ONE artifact: filtering an integrated VD is
    // CHAINING (a VD-on-a-VD, resolved bottom-up), not one recipe carrying both. The masked
    // reader indexes the mask in the pre-mask plan's order, which for a multi-source alignment
    // is OUTPUT order, not source order — so honouring a mask here would mis-index it silently.
    // Refuse by name rather than serve the wrong rows.
    if recipe_for_key.mask_artifact_id.is_some() {
        return Err(AppError::bad_request(
            "GATHER_MASK_WITH_ALIGNMENT",
            "this recipe names BOTH an alignment and a mask. A mask filters a SINGLE source in \
             that source's own row order; filtering an integrated (aligned) dataset is done by \
             CHAINING a filter VD over the integration VD, never by one recipe carrying both. \
             Serving the mask against the aligned output rows would drop the wrong rows.",
        ));
    }

    // ── THE ORDER IS THE INVARIANT ─────────────────────────────────────────────────
    //
    //   1. resolve the alignment's METADATA (a catalog read),
    //   2. verify EVERY LEAF's key-sequence digest — still metadata, and done for the WHOLE
    //      chain up in `plan_chain` before this function is called even once,
    //   3. only then fetch the alignment's vector bytes,
    //   4. only then fetch source bytes, and gather.
    //
    // Step 2 sits ahead of steps 3 and 4 deliberately and it is asserted, not commented: a
    // digest check that runs AFTER the fetch passes every assertion about refusal while
    // doing the expensive wrong thing, and a positional read against a changed source is the
    // failure with the right count, the wrong rows and a clean console. It is the same
    // ordering mistake as a cache consulted ahead of its gate — right answer, wrong place —
    // and `a_changed_source_is_refused_before_a_single_source_byte_is_fetched` is what stops
    // it being reintroduced. Hoisting it to `plan_chain` is what keeps the claim true of a
    // READ rather than merely of a node: otherwise an intermediate's bytes would be fetched
    // before its parent's siblings were ever checked.
    let (plan, _alignment_hash) =
        load_alignment_plan(pool, self_artifact_id, &recipe_for_key).await?;
    // `load_alignment_plan` refuses a null alignment, so the id is present from here on; bind
    // it once (no unwrap) and reuse it for the row-count refusal + vector reads below.
    let alignment_id = recipe_for_key.require_alignment()?;
    // (2) — every source of the alignment, not merely the ones this chunk happens to touch.
    // Chunk-scoped verification would let a chunk that misses a changed source serve happily
    // while its neighbour refuses: one column, two answers, depending on which pane asked.
    let mut source_artifacts: Vec<(usize, Uuid)> = Vec::new();
    // Each source's OWN declared element width, read from its own `structure` — the width its
    // bytes actually are, which is a different number from the width this column declares
    // whenever the unified vocabulary needed more room. Collected here, in the loop that
    // already holds each source's row, rather than re-fetched later.
    let mut source_dtypes: Vec<Option<String>> = Vec::new();
    for (ix, src) in plan.sources.iter().enumerate() {
        let artifact_id = recipe_for_key.artifact_for_dataset(&src.dataset_id)?;
        let found = CatalogRepository::new(pool.clone())
            .get_any_status(artifact_id)
            .await?;
        let row = match found {
            Some(row) => row,
            // DISCOVERY POINT 1 — a source artifact is gone. Recorded on THIS artifact (the
            // gathered one being read), never on the source: the source does not exist, and
            // the row whose readability changed is this one.
            None => {
                return Err(mark_unresolvable_then_refuse(
                    pool,
                    self_artifact_id,
                    &format!("dataset {:?} (artifact {artifact_id})", src.dataset_id),
                    AppError::bad_request(
                        "ARTIFACT_UNRESOLVABLE",
                        format!(
                            "this column reads through dataset {:?}, whose artifact \
                             {artifact_id} no longer exists. INV-9: the refusal names the \
                             source that went missing rather than rendering short.",
                            src.dataset_id
                        ),
                    ),
                )
                .await)
            }
        };
        // ── THE IDENTITY CHECK LIVES IN `plan_chain` ──────────────────────────────────
        //
        // Every LEAF's `key_sequence_digest` / `aligned_to` was verified against this
        // alignment's pin during the walk, for the WHOLE chain, before this function ran
        // once. Repeating it here would only re-read what is already known; hoisting it is
        // what makes "refused before a single source byte is fetched" a claim about the READ
        // rather than about one node of it.
        //
        // What CANNOT be checked up there, because it needs the intermediate to be resolved,
        // is its SHAPE. A chained source contributes the rows its own gather produced, and
        // the outer alignment declares how many rows it expected from that dataset. If the
        // two disagree, the recipe has bound this dataset to the wrong virtual column — and
        // a positional read against it returns the right kind of bytes for the wrong rows,
        // which is the failure the digest pin exists for, arriving through the one door the
        // pin cannot cover.
        if let Some(buf) = chain.get(&artifact_id) {
            if buf.n() != src.n_rows {
                return Err(AppError::bad_request(
                    "GATHER_CHAIN_ROW_COUNT_MISMATCH",
                    format!(
                        "this column reads dataset {:?} through artifact {artifact_id}, which \
                         is itself gathered and resolves to {} row(s) — but alignment {} was \
                         computed against {} row(s) for that dataset. The row vector is \
                         POSITIONAL, so gathering through it anyway would return rows from \
                         positions the alignment never described.",
                        src.dataset_id,
                        buf.n(),
                        alignment_id,
                        src.n_rows,
                    ),
                ));
            }
        }
        source_dtypes.push(super::virtual_dataset::source_dtype(
            &row.structure,
            &recipe_for_key.column_selector,
        ));
        source_artifacts.push((ix, artifact_id));
    }

    // (3) — the alignment's own vectors. Decoded in `gather_decode`, the one module INV-1's
    // amendment (DEC-23) permits to open an artifact byte. `alignment_id` was bound once above.
    let vectors = super::alignment::AlignmentVectors::bind(
        &plan,
        super::alignment::AlignmentVectors {
            // D18 (ITEM-11): the per-row `row_source`/`row_segment` vectors are gone — output
            // positions reconstruct from the segment table (`resolve_row`), so only the four
            // per-SEGMENT vectors are decoded.
            segment_source: read_numeric_member(
                pool,
                store,
                alignment_id,
                &plan.segment_dataset.path,
            )
            .await?
            .into_iter()
            .map(|v| v as u32)
            .collect(),
            segment_start: read_numeric_member(pool, store, alignment_id, &plan.segment_start.path)
                .await?,
            segment_end: read_numeric_member(pool, store, alignment_id, &plan.segment_end.path)
                .await?,
            segment_order: read_numeric_member(pool, store, alignment_id, &plan.segment_order.path)
                .await?
                .into_iter()
                .map(|v| v as u32)
                .collect(),
        },
    )?;

    // (4) — this chunk's rows, then the sources they actually name.
    let row_plan: Vec<(usize, usize)> = (0..plan.n_rows)
        .map(|i| vectors.resolve_row(i))
        .collect::<Result<_, _>>()?;

    // A SPLIT string column has no fixed element width — its values are bounded by an
    // offsets member — so `item_size` is not asked. Asking it first is what made the split
    // path unreachable: the flat path's assumption ran before the branch that does not share
    // it, and answered `GATHER_DTYPE_UNSUPPORTED` for the column this item exists to serve.
    let declared_dtype = structure
        .get("data_type")
        .and_then(|v| v.as_str())
        .unwrap_or("float32");
    let is_split = declared_dtype == "utf8";
    let item = if is_split {
        1
    } else {
        super::gathered::item_size(declared_dtype)?
    };

    // The flat element bytes — NOT read for a split column, whose `<member>` is a GROUP with
    // `offsets`/`values` beneath it. Reading it anyway is what surfaced as "array declares no
    // codecs": the flat path's assumption running for a shape that does not share it, one
    // step after the same mistake with `item_size`.
    //
    // **A CHAINED source is taken from `chain` rather than read** — it has no blob to read
    // (that is what makes it a chain), and its bytes were produced by the same `resolve_node`
    // this is, one level down. `chain_item` records the width they came out at, so the
    // derivation below does not have to guess it back from a declaration.
    let mut sources: Vec<Vec<u8>> = Vec::with_capacity(source_artifacts.len());
    let mut chain_item: Vec<Option<usize>> = vec![None; source_artifacts.len()];
    if !is_split {
        for (slot, (_, artifact_id)) in source_artifacts.iter().enumerate() {
            if let Some(buf) = chain.get(artifact_id) {
                let (bytes, w) = buf.flat(*artifact_id)?;
                chain_item[slot] = Some(w);
                sources.push(bytes.to_vec());
                continue;
            }
            sources.push(
                read_member_element_bytes(
                    pool,
                    store,
                    *artifact_id,
                    &recipe_for_key.column_selector,
                )
                .await?,
            );
        }
    }

    // ── EACH SOURCE'S OWN ELEMENT WIDTH ────────────────────────────────────────────
    //
    // The DECLARATION first: `structure.columns[…].dtype` is the producer's own statement of
    // what its bytes are, and it is the contract.
    //
    // **When a source declares none, the width is DERIVED from the bytes — not assumed.**
    // The first version of this assumed the gathered width, which is the very assumption the
    // regression was made of: it is right exactly when there is nothing to convert and wrong
    // exactly when there is. The derivation is not a guess either — the buffer holds one
    // element per row of that source, and the alignment declares that row count, so
    // `bytes / rows` is the width, checked for divisibility rather than rounded.
    //
    // Only if BOTH are unavailable does it fall back to the gathered width, which is the
    // pre-existing behaviour for a source that declares nothing and whose row count the
    // alignment does not state.
    let source_item: Vec<usize> = if is_split {
        vec![1; source_artifacts.len()]
    } else {
        source_artifacts
            .iter()
            .enumerate()
            .map(|(slot, (ix, _))| {
                // A CHAINED source's width is a MEASUREMENT, not a declaration — it is what
                // the inner gather actually emitted — so it outranks the inner artifact's
                // own `structure`. They agree today; if they ever stop, the bytes are the
                // fact and the declaration is the bug.
                if let Some(w) = chain_item.get(slot).copied().flatten() {
                    return w;
                }
                if let Some(w) = source_dtypes
                    .get(slot)
                    .and_then(|d| d.as_deref())
                    .and_then(|dt| super::gathered::item_size(dt).ok())
                {
                    return w;
                }
                let rows = plan.sources.get(*ix).map(|s| s.n_rows).unwrap_or(0);
                let bytes = sources.get(slot).map(Vec::len).unwrap_or(0);
                if rows > 0 && bytes % rows == 0 && bytes / rows > 0 {
                    bytes / rows
                } else {
                    item
                }
            })
            .collect()
    };

    // ── THE LEVEL REMAP — a fused categorical's codes are per-SOURCE ────────────────
    //
    // Each source has its OWN code space, and the alignment's `alignment_level_lookup`
    // members are the producer's map from a source's local code to the UNIFIED code.
    // Serving raw codes hands the client one source's numbers read against another's
    // vocabulary: on the reference alignment ds-b's lookup is `[0, 2, 1]`, so its `NK` row
    // arrived labelled `T` and its `T` row labelled `NK`. Correct count, plausible values,
    // wrong biology, clean console — and two suites pinned it as correct until a blind audit
    // decoded the committed bytes.
    //
    // Applied to the source BUFFERS rather than during assembly, so `gather_chunk_multi`
    // stays the single assembly both the byte route and stage-time materialisation use.
    // **The ALIGNMENT's name for the column, which is not the member path.** Under the
    // producer's slot-family layout the member is always `values` and the column name rides
    // the slot (`level:<i>:group`); keying the lookups on the member path finds none, takes
    // the no-remap branch, and serves each source's RAW per-source codes — CRITICAL-2 of
    // this stage, re-reachable through a name. See `GatheredFrom::alignment_column`.
    //
    // A DECLARED name the alignment does not fuse is refused rather than silently treated as
    // "no remap": the two are different facts with different remedies, and the quiet one is
    // the one that serves plausible wrong biology.
    //
    // …and a recipe that never MENTIONED the key is refused too, separately. Absence of the
    // key and a declared `null` produce identical bytes, so no assertion over the output can
    // tell them apart — the distinction has to live in the type, and it does
    // (`ColumnVocabulary`). Assuming "no remap" for a writer that simply forgot is CRITICAL-2
    // re-reached through ABSENCE rather than through a name.
    let column = match recipe_for_key.vocabulary() {
        super::gathered::ColumnVocabulary::Undeclared => {
            return Err(AppError::bad_request(
                "GATHER_ALIGNMENT_COLUMN_UNDECLARED",
                format!(
                    "this recipe carries no `alignment_column` key at all. That is not the                      same as declaring `null`: `null` says the gather fuses no vocabulary                      (the key/identifier gather), while an absent key says nothing was                      decided — and treating the two alike serves each source's RAW code                      space against alignment {}'s unified vocabulary, with the right row                      count and the wrong biology. Write `\"alignment_column\": null` if the                      column genuinely fuses nothing. The alignment fuses: {:?}",
                    alignment_id,
                    plan.remapped_columns()
                ),
            ))
        }
        super::gathered::ColumnVocabulary::DeclaredNone => None,
        super::gathered::ColumnVocabulary::Fused(c) => Some(c),
    };
    let column = match column {
        Some(c) if !is_split && !plan.remaps_levels_for(&c) => {
            return Err(AppError::bad_request(
                "GATHER_ALIGNMENT_COLUMN_UNKNOWN",
                format!(
                    "the recipe declares alignment column {c:?}, but alignment {} declares no \
                     `levels__{c}__<source>` lookup for it. Treating that as \"no remap\" \
                     would serve each source's own code space read against the unified \
                     vocabulary — the right count, plausible values and the wrong biology. \
                     The alignment fuses: {:?}",
                    alignment_id,
                    plan.remapped_columns()
                ),
            ))
        }
        other => other,
    };
    // A remap happens exactly when the recipe NAMES an alignment column (and the branch above
    // has already refused a name the alignment does not fuse). No empty-string sentinel: ""
    // would read as a column name at every later site.
    if let (false, Some(column)) = (is_split, column.as_deref()) {
        for (src_ix, _) in source_artifacts.iter().map(|(i, a)| (*i, *a)) {
            let member = plan.level_lookup_for(column, src_ix).ok_or_else(|| {
                AppError::bad_request(
                    "GATHER_LEVEL_LOOKUP_MISSING",
                    format!(
                        "the alignment remaps levels for {column:?} but declares no lookup for \
                         source {src_ix} ({:?}). Serving that source's raw codes would read its \
                         vocabulary against another's",
                        plan.sources.get(src_ix).map(|s| s.dataset_id.as_str())
                    ),
                )
            })?;
            let path = member.path.clone();
            // SIGNED, deliberately. The producer writes **`-1` for absence** — a source level
            // that is not in the unified vocabulary — and reading the lookup as unsigned
            // turns that into 18446744073709551615, which the width-preserving write then
            // truncates to `0xff`. A `uint8` column would have served code 255: an index into
            // the vocabulary that is either out of range or, worse, a real label. Absence is
            // not a code, and it is refused here rather than becoming one.
            let lookup = read_numeric_member_i64(pool, store, alignment_id, &path).await?;
            // **THE SOURCE'S OWN WIDTH IN, THE GATHERED WIDTH OUT.** They differ exactly when
            // the unified vocabulary needs more room than a source's own, which is the case
            // `unified_code_dtype` exists for — and passing the gathered width for BOTH is a
            // mismatch against bytes nothing converted.
            sources[src_ix] =
                super::gathered::remap_codes(&sources[src_ix], source_item[src_ix], item, &lookup)?;
        }
    }

    // ── EVERY SOURCE BUFFER IS NOW AT THE GATHERED WIDTH — asserted, not assumed ──────
    //
    // `gather_chunk_multi` indexes `row * item` into these buffers, so the invariant it rests
    // on is that the remap above converted each of them. A column with no remap satisfies it
    // for a different reason: the creator declares the SOURCES' width when it fuses no
    // vocabulary, so the two coincide. The one shape that satisfies neither is a row declaring
    // a width its bytes cannot supply, and it is refused HERE by name rather than surfacing as
    // an off-by-one code three layers down.
    if !is_split {
        for (ix, buf) in sources.iter().enumerate() {
            if source_item[ix] != item && column.is_none() {
                return Err(AppError::bad_request(
                    "GATHER_WIDTH_UNCONVERTIBLE",
                    format!(
                        "source {ix} stores {}-byte elements but this column declares {item}-byte \
                         ones, and it fuses no vocabulary — so there is no remap to convert them. \
                         Serving these bytes at the declared width reads across row boundaries: \
                         the declaration and the bytes disagree and only the producer can say \
                         which is right",
                        source_item[ix]
                    ),
                ));
            }
            if item == 0 || buf.len() % item != 0 {
                return Err(AppError::bad_request(
                    "GATHER_WIDTH_UNCONVERTIBLE",
                    format!(
                        "source {ix} holds {} byte(s), which is not a whole number of \
                         {item}-byte elements after the remap",
                        buf.len()
                    ),
                ));
            }
        }
    }

    // ── A SPLIT STRING COLUMN — the axis's own keys (ITEM-22(b)) ───────────────────
    //
    // Detected from the DECLARATION (`data_type: "utf8"`), not sniffed: a string column's
    // bytes are two members, and deciding which shape to gather by looking at bytes is the
    // thing this server does not do. The offsets are RECOMPUTED by `gather_split_strings` —
    // a copied array is right for the first segment and wrong after, and these are the keys
    // every row is labelled with.
    let strings = if is_split {
        let mut split_sources: Vec<(Vec<u32>, Vec<u8>)> =
            Vec::with_capacity(source_artifacts.len());
        for (_, artifact_id) in &source_artifacts {
            // A CHAINED source again — the inner gather already RECOMPUTED these offsets
            // (`gather_split_strings` never copies a source's array, because a copied one is
            // right for the first segment and wrong after it), so they are taken whole.
            if let Some(buf) = chain.get(artifact_id) {
                let (offsets, values) = buf.split(*artifact_id)?;
                split_sources.push((offsets.to_vec(), values.to_vec()));
                continue;
            }
            let offsets = read_numeric_member(
                pool,
                store,
                *artifact_id,
                &format!("{}/offsets", recipe_for_key.column_selector),
            )
            .await?
            .into_iter()
            .map(|v| v as u32)
            .collect();
            let values = read_member_element_bytes(
                pool,
                store,
                *artifact_id,
                &format!("{}/values", recipe_for_key.column_selector),
            )
            .await?;
            split_sources.push((offsets, values));
        }
        Some(super::gathered::gather_split_strings(
            &row_plan,
            &split_sources,
        )?)
    } else {
        None
    };

    // ── THE UNIFIED VOCABULARY — a straight copy, never a derivation ───────────────
    //
    // Stage 1 emits it on the alignment store's GROUP attributes:
    //   `<alignment>.zarr/zarr.json` → `attributes.cyto_alignment.unified_levels[<column>]`
    // with the INDEX being the unified code. It rides group attributes rather than
    // `structure` because `structure` also travels into the artifact row, which has a hard
    // manifest-size cap — the cap that already forced a large member entry down to a digest.
    // A vocabulary truncated there would be lost exactly where labels matter most.
    //
    // It is copied verbatim: not derived, not reordered, not filtered. Assembling a plausible
    // label set on this side from the lookups would be the self-agreeing oracle — right for
    // the fixture in front of me and wrong wherever cardinality is high and nobody checks.
    //
    // ── AND THE ENTRY THAT MEANS ABSENCE, CARRIED WITH IT (DEC-27) ────────────────
    //
    // Stage 1's missing-level mechanism APPENDS a real, declared label to the unified
    // vocabulary for a level `authority` dropped, and points the absent codes at its index.
    // So `levels` above already contains it and every code is in range — which is exactly
    // why the serve path needed no change and why `remap_codes`' negative-code refusal became
    // unreachable rather than wrong.
    //
    // But WHICH entry is the invented one is **declared, not derivable** — that is the whole
    // reason stage 1 emits `missing_levels` beside the vocabulary rather than letting a
    // consumer guess. Carrying `levels` without it loses that property at the ONE surface
    // that has a renderer: the browser would show a category literally named `NA`,
    // indistinguishable from a real level a dataset happens to spell that way. It is the
    // same shape as this stage's `ColumnVocabulary`: two states that render identically
    // cannot be told apart by any assertion on the output, so the distinction has to be
    // carried rather than inferred.
    //
    // Read from the SAME group document as the vocabulary, in one fetch, so the two cannot
    // be read from different versions of the alignment.
    let (levels, missing_level) = if let Some(column) = column.as_deref() {
        let group = super::data_api::read_member_bytes(pool, store, alignment_id, "zarr.json")
            .await
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        let at = |key: &str| {
            group
                .as_ref()
                .and_then(|g| g.pointer(&format!("/attributes/cyto_alignment/{key}")))
                .and_then(|v| v.get(column))
                .cloned()
                // A declared JSON `null` is "this run dropped nothing", which is the same
                // fact as the key being absent — both mean there is no invented entry to
                // name. Collapsing them here is safe precisely because neither is a label.
                .filter(|v| !v.is_null())
        };
        (at("unified_levels"), at("missing_levels"))
    } else {
        (None, None)
    };

    Ok(ResolvedGather {
        row_plan,
        sources,
        strings,
        levels,
        missing_level,
        item,
        n: plan.n_rows,
        chunk_elements: super::gathered::chunk_elements_of(structure),
        structure: structure.clone(),
    })
}

/// Record that this gathered artifact can no longer be resolved, then let the refusal fly.
///
/// **ORDERING, decided rather than inherited: the status is written BEFORE the refusal is
/// returned, and the write is AWAITED.**
///
/// The alternative — refuse first, record after — is not expressible here and would be wrong
/// if it were: both discovery points return through `?`, so anything "after" the refusal never
/// runs. A detector that only fires when nothing short-circuits is a detector that never fires
/// on the path it exists for.
///
/// Writing first does mean the row can carry a state the CALLER never saw (their request could
/// drop between the write and the response). That asymmetry is the right one: the record is
/// durable and the refusal is per-request, so the row outliving one response is the point —
/// the next reader, and stage 3's surface, learn the condition without having to re-trigger it.
///
/// **A failed write never replaces the refusal.** The caller asked for bytes and the honest
/// answer is the named refusal; losing it to a `database_error` would trade a diagnosis for a
/// 500 — the split-the-bucket rule this stage has already paid for four times. So the write's
/// error is logged and dropped, and the refusal the caller passed in is what is returned.
async fn mark_unresolvable_then_refuse(
    pool: &SqlitePool,
    artifact_id: Uuid,
    unresolved_source: &str,
    refusal: AppError,
) -> AppError {
    match CatalogRepository::new(pool.clone())
        .mark_unresolvable(artifact_id, unresolved_source)
        .await
    {
        // `true` = THIS call moved it, so the log line is a transition and not a heartbeat.
        Ok(true) => tracing::warn!(
            artifact_id = %artifact_id,
            "gathered artifact moved to `unresolvable`: {refusal}"
        ),
        Ok(false) => tracing::debug!(
            artifact_id = %artifact_id,
            "gathered artifact already `unresolvable` (or not a gathered row); no transition"
        ),
        Err(e) => tracing::error!(
            artifact_id = %artifact_id,
            "could not record `unresolvable` (the refusal below still stands): {e}"
        ),
    }
    refusal
}

/// Little-endian read of one element of `item` bytes.
fn read_le(b: &[u8]) -> u64 {
    let mut v = 0u64;
    for (i, byte) in b.iter().enumerate().take(8) {
        v |= (*byte as u64) << (8 * i);
    }
    v
}

/// Little-endian write of one element, preserving width.
fn write_le(b: &mut [u8], v: u64) {
    for (i, byte) in b.iter_mut().enumerate().take(8) {
        *byte = ((v >> (8 * i)) & 0xff) as u8;
    }
}

/// One numeric member decoded to SIGNED values — for the level lookups, where `-1` means
/// absence and must survive as `-1` rather than wrapping.
async fn read_numeric_member_i64(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    artifact_id: Uuid,
    member: &str,
) -> Result<Vec<i64>, AppError> {
    let (plan, raw) = read_member_decoded(pool, store, artifact_id, member).await?;
    Ok(match plan.item_size {
        1 => raw.iter().map(|b| *b as i8 as i64).collect(),
        2 => raw
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as i64)
            .collect(),
        4 => raw
            .chunks_exact(4)
            .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as i64)
            .collect(),
        _ => raw
            .chunks_exact(8)
            .map(|c| i64::from_le_bytes(c.try_into().expect("8 bytes")))
            .collect(),
    })
}

/// One numeric member of an artifact's store, decoded to `u64` values.
///
/// Used for the alignment's own vectors, whose dtypes the producer picks per member
/// (`int64` for rows, `int32` for segments) — so the caller narrows, and this reads whatever
/// width was declared rather than assuming one.
async fn read_numeric_member(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    artifact_id: Uuid,
    member: &str,
) -> Result<Vec<u64>, AppError> {
    let (plan, raw) = read_member_decoded(pool, store, artifact_id, member).await?;
    Ok(match plan.item_size {
        1 => raw.iter().map(|b| *b as u64).collect(),
        2 => raw
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]) as u64)
            .collect(),
        4 => raw
            .chunks_exact(4)
            .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as u64)
            .collect(),
        _ => raw
            .chunks_exact(8)
            .map(|c| i64::from_le_bytes(c.try_into().expect("8 bytes")) as u64)
            .collect(),
    })
}

/// One member's plaintext ELEMENT bytes — what the gather indexes by row.
async fn read_member_element_bytes(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    artifact_id: Uuid,
    member: &str,
) -> Result<Vec<u8>, AppError> {
    Ok(read_member_decoded(pool, store, artifact_id, member)
        .await?
        .1)
}

/// Fetch a member's declaration and shards, then decode it.
///
/// **This is the only place in the serve path that opens artifact bytes**, and it does so
/// through `gather_decode`, whose codec allowance is three names wide and refuses anything
/// else by name (DEC-23).
async fn read_member_decoded(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    artifact_id: Uuid,
    member: &str,
) -> Result<(super::gather_decode::DecodePlan, Vec<u8>), AppError> {
    let meta_bytes = super::data_api::read_member_bytes(
        pool,
        store,
        artifact_id,
        &format!("{member}/zarr.json"),
    )
    .await?;
    let meta: serde_json::Value = serde_json::from_slice(&meta_bytes).map_err(|e| {
        AppError::internal_error(format!(
            "artifact {artifact_id} member {member:?} has no readable zarr.json: {e}"
        ))
    })?;
    let plan = super::gather_decode::DecodePlan::parse(&meta)?;

    // Fetch exactly the shards the DECLARATION says exist, rather than probing until a
    // fetch fails: a `while let Ok(..)` loop cannot tell "there are no more" from "this one
    // could not be read", and `decode_member` would then fill the gap with zeros.
    let want = plan.n.div_ceil(plan.shard.max(1));
    let mut shards = Vec::with_capacity(want);
    for s in 0..want {
        let bytes = super::data_api::read_member_bytes(
            pool,
            store,
            artifact_id,
            &format!("{member}/c/{s}"),
        )
        .await
        .map_err(|e| {
            AppError::internal_error(format!(
                "artifact {artifact_id} member {member:?} declares {want} shard(s) and \
                         shard {s} could not be read: {e}"
            ))
        })?;
        shards.push((s, bytes));
    }
    if shards.is_empty() {
        return Err(AppError::internal_error(format!(
            "artifact {artifact_id} member {member:?} declares {} element(s) but holds no \
             shards — a decode of nothing would return a full-length column of fill",
            plan.n
        )));
    }
    let raw = super::gather_decode::decode_member(&plan, &shards)?;
    Ok((plan, raw))
}

/// **Read a contiguous ELEMENT window `[lo, hi)` of a member — only the shards that cover it
/// (ITEM-5).**
///
/// The masked sparse serve reads ONE column's `indices[lo:hi]` / `data[lo:hi]` slice; fetching the
/// whole member to slice a few-thousand-nonzero column is the `O(nnz total)` read INV-22 forbids.
/// This fetches ONLY the covering shards (`[lo/shard ..= (hi-1)/shard]`) and decodes just the
/// window through the same `gather_decode` seam (DEC-23) every other member read uses.
async fn read_member_element_window(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    artifact_id: Uuid,
    member: &str,
    lo: usize,
    hi: usize,
) -> Result<Vec<u8>, AppError> {
    let meta_bytes = super::data_api::read_member_bytes(
        pool,
        store,
        artifact_id,
        &format!("{member}/zarr.json"),
    )
    .await?;
    let meta: serde_json::Value = serde_json::from_slice(&meta_bytes).map_err(|e| {
        AppError::internal_error(format!(
            "artifact {artifact_id} member {member:?} has no readable zarr.json: {e}"
        ))
    })?;
    let plan = super::gather_decode::DecodePlan::parse(&meta)?;
    if hi == lo {
        return Ok(Vec::new());
    }
    let shard = plan.shard.max(1);
    let (s0, s1) = (lo / shard, (hi - 1) / shard);
    let mut shards = Vec::with_capacity(s1 - s0 + 1);
    for s in s0..=s1 {
        let bytes = super::data_api::read_member_bytes(
            pool,
            store,
            artifact_id,
            &format!("{member}/c/{s}"),
        )
        .await
        .map_err(|e| {
            AppError::internal_error(format!(
                "artifact {artifact_id} member {member:?} window {lo}..{hi} needs shard {s}, \
                 which could not be read: {e}"
            ))
        })?;
        shards.push((s, bytes));
    }
    super::gather_decode::decode_member_window(&plan, &shards, lo, hi)
}

/// **Serve ONE masked column of a virtual sparse (`sparse_csc`) dataset (ITEM-5, §11.1i).**
///
/// A CSC matrix is compressed by column, so a column is a contiguous slice — this reads
/// `indptr[C..C+2]` to bound the column, WINDOW-reads that column's `indices`/`data` (only its
/// nonzeros, INV-22), applies the virtual dataset's per-source mask (filter + rank-renumber,
/// reusing the ONE cached [`MaskPlan`] per `(dataset, mask)` — INV-23/E7), and returns the sparse
/// wire (`u32 n | u32[n] row | f32[n] value`) the viz decodes exactly as a real column (INV-25).
/// Absence of a mask is the identity read (a real dataset / all-keep), byte-equivalent to reading
/// the source column directly (INV-11).
///
/// The mask NEVER co-occurs with an alignment in one recipe (filtering an integrated dataset is
/// CHAINING, §11.1i); a multi-source recipe is refused here rather than served without its
/// segment offsets. The `indptr` is read whole (it is `n_cols + 1`, tiny); only the ONE column's
/// value slice is fetched, so the serve is `O(nnz in the column)`, never the whole matrix (INV-22).
pub async fn resolve_masked_sparse_column(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    artifact_id: Uuid,
    structure: &serde_json::Value,
    col: usize,
) -> Result<Vec<u8>, AppError> {
    use super::gathered;

    // The gathered artifact's own id is not read from — the read is scoped to its SOURCE, and
    // discovery of a deleted source happens there. Bound once for signature symmetry with
    // `resolve`/`resolve_shared`, exactly as `resolve_single_source_node` binds `self_artifact_id`.
    let _ = artifact_id;
    let recipe = gathered::GatheredFrom::parse(structure)?;
    // A masked sparse column is a LONE-source read (a filter VD or a real dataset's identity read).
    // A multi-source integrated sparse read composes per-source segment offsets and is CHAINING
    // (§11.1i) — refused by name rather than served with a missing offset.
    if recipe.sources.len() != 1 {
        return Err(AppError::bad_request(
            "GATHER_RECIPE_INVALID",
            format!(
                "a masked sparse column read has exactly ONE source (a lone-source filter or an \
                 identity read); this recipe has {}. A filtered INTEGRATION is chaining, not one \
                 recipe carrying both a mask and an alignment (INV-3/§11.1i).",
                recipe.sources.len()
            ),
        ));
    }
    let source = recipe.sources[0].artifact_id;

    // The CSC member names — the standard `indptr`/`indices`/`data` trio. Read from the declaration
    // when present so an address cannot silently disagree with what the row publishes, defaulting
    // to the trio a real CSC store writes.
    let member = |key: &str, default: &str| -> String {
        structure
            .pointer(&format!("/gathered_from/{key}"))
            .and_then(|v| v.as_str())
            .unwrap_or(default)
            .to_string()
    };
    let (indptr_m, indices_m, data_m) = (
        member("indptr_member", "indptr"),
        member("indices_member", "indices"),
        member("data_member", "data"),
    );

    // `indptr` whole — `n_cols + 1`, tiny — then this column's [lo,hi) window of the value members.
    let indptr = read_numeric_member_i64(pool, store, source, &indptr_m).await?;
    let (lo, hi) = match (indptr.get(col), indptr.get(col + 1)) {
        (Some(&lo), Some(&hi)) if lo >= 0 && hi >= lo => (lo as usize, hi as usize),
        _ => {
            return Err(AppError::bad_request(
                "GATHER_RECIPE_INVALID",
                format!(
                    "column {col} is out of range or its indptr bounds run backwards — indptr \
                     addresses {} column(s)",
                    indptr.len().saturating_sub(1)
                ),
            ))
        }
    };
    let indices_bytes = read_member_element_window(pool, store, source, &indices_m, lo, hi).await?;
    let data_bytes = read_member_element_window(pool, store, source, &data_m, lo, hi).await?;
    let indices: Vec<u32> = indices_bytes
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let data: Vec<f32> = data_bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    // The window is already `[lo,hi)`, so the column's local slice is `0..(hi-lo)`. Re-express the
    // column bounds in the window's coordinates and hand `gather_sparse_column` a one-column indptr.
    let local_indptr = [0i64, (hi - lo) as i64];

    // The mask → its cached (keep, rank). Absence is the identity read (INV-11).
    let mask_plan = match recipe.mask_artifact_id {
        None => None,
        Some(mask_id) => Some(mask_plan(pool, store, mask_id).await?),
    };

    // ── the mask-length guard (INV-5/INV-2, the SPARSE sibling of the dense refusal, C2) ───────
    // The mask is per-SOURCE-ROW in the source's own row order (DEC-11); a CSC matrix's row
    // count is its first-axis extent (`shape[0]`). The per-nonzero bounds check inside
    // `gather_sparse_column` (`keep.get(p)`) catches a mask SHORTER than the largest nonzero row,
    // but it misses an OVER-LONG mask (every `p` is still in range) and a short mask for a column
    // whose nonzeros all fall before the mask's end — both serve the wrong rows silently. So the
    // whole-mask length is refused up front, exactly as `resolve_single_source_node` does for a
    // dense column: the two sibling paths must agree on the same bad input, not one refuse it and
    // the other serve a wrong answer with a clean console.
    if let Some(mp) = &mask_plan {
        if let Some(n_rows) = structure.pointer("/shape/0").and_then(Value::as_u64) {
            let n_rows = n_rows as usize;
            if mp.keep.len() != n_rows {
                return Err(AppError::bad_request(
                    "GATHER_MASK_LENGTH_MISMATCH",
                    format!(
                        "mask selects {} row(s) but source matrix {source} declares {n_rows} \
                         row(s) (shape[0]) — the mask is per-source-row in the source's own \
                         order (DEC-11), so a length disagreement means it was computed against a \
                         different row sequence and a positional filter would serve the wrong \
                         rows (INV-5).",
                        mp.keep.len()
                    ),
                ));
            }
        }
    }

    let slice = match &mask_plan {
        None => gathered::gather_sparse_column(&local_indptr, &indices, &data, 0, None, 0)?,
        Some(mp) => gathered::gather_sparse_column(
            &local_indptr,
            &indices,
            &data,
            0,
            Some((&mp.keep, &mp.rank)),
            0,
        )?,
    };
    Ok(gathered::encode_sparse_slice_wire(&slice))
}

/// Load the alignment artifact a gathered column reads through, and parse its plan.
///
/// Metadata only — `structure` and `meta` are producer-DECLARED JSON the server reads as
/// control plane, which is why this is legal where decoding the same artifact's arrays is
/// not.
///
/// Returns the plan **and the alignment's `content_hash`**. The hash is not decoration: it is
/// what makes the alignment's contribution to [`resolution_key`] a CONTENT address rather than
/// an id, so a cached resolution can only be reused for byte-identical vectors.
async fn load_alignment_plan(
    pool: &SqlitePool,
    self_artifact_id: Uuid,
    recipe: &super::gathered::GatheredFrom,
) -> Result<(super::alignment::AlignmentPlan, String), AppError> {
    let repo = CatalogRepository::new(pool.clone());
    // A recipe reaching the alignment gather must NAME an alignment; a single-source masked
    // recipe (`alignment_artifact_id: null`) is served elsewhere (ITEM-3). The null is funnelled
    // through one refusal rather than unwrapped — see [`GatheredFrom::require_alignment`].
    let alignment_id = recipe.require_alignment()?;
    let a = match repo.get_any_status(alignment_id).await? {
        Some(a) => a,
        // DISCOVERY POINT 2 — the alignment itself is gone.
        None => {
            return Err(mark_unresolvable_then_refuse(
                pool,
                self_artifact_id,
                &format!("alignment {alignment_id}"),
                AppError::bad_request(
                    "ARTIFACT_UNRESOLVABLE",
                    format!(
                        "this column reads through alignment {alignment_id}, which no longer \
                         exists — the alignment was deleted out from under it. Naming it is \
                         the point (INV-9): a short or empty read here would look like an \
                         answer."
                    ),
                ),
            )
            .await)
        }
    };
    let hash = a.content_hash.clone();
    Ok((
        super::alignment::AlignmentPlan::parse(&a.structure, &a.meta)?,
        hash,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The `rank` is the exclusive prefix-sum of the keep vector, and `N_kept` its total.**
    ///
    /// `rank[i]` is the OUTPUT position a kept row `i` lands at; a dropped row's entry is the
    /// running kept-count so far (unused, but well-defined). This is the arithmetic the future
    /// per-gene path uses to place a source row in O(1) without walking the whole plan.
    ///
    /// nc: make `from_keep` count the row it is on (inclusive prefix-sum) and `rank[0]` for a
    /// kept row 0 becomes 1 not 0 — every kept row is shifted one output position.
    #[test]
    fn mask_plan_rank_is_the_exclusive_prefix_sum() {
        let mp = MaskPlan::from_keep(vec![true, false, true, true, false]);
        assert_eq!(mp.rank, vec![0, 1, 1, 2, 3]);
        assert_eq!(mp.n_kept, 3, "three rows kept");
    }

    /// **`apply` filters a plan to the kept rows IN ORDER — filter + rank + segment-offset in one
    /// pass, output ascending by construction (ITEM-3, INV-25).**
    ///
    /// nc: drop the `filter_map` guard (keep every row) and the result is the full plan — the
    /// mask would be inert.
    #[test]
    fn mask_plan_apply_keeps_rows_in_output_order() {
        let mp = MaskPlan::from_keep(vec![true, false, true, true, false]);
        let base: Vec<(usize, usize)> = (0..5).map(|r| (0, r)).collect();
        assert_eq!(mp.apply(&base), vec![(0, 0), (0, 2), (0, 3)]);
    }

    /// An all-keep mask is the identity plan — every row survives at its own position (INV-11).
    #[test]
    fn an_all_keep_mask_plan_is_identity() {
        let mp = MaskPlan::from_keep(vec![true, true, true]);
        assert_eq!(mp.n_kept, 3);
        let base: Vec<(usize, usize)> = (0..3).map(|r| (0, r)).collect();
        assert_eq!(mp.apply(&base), base);
    }

    /// **The rank is BUILT ONCE per `(dataset, mask)` and reused across columns (INV-23/E7).**
    ///
    /// The cache holds ONE `MaskPlan` per mask key; a second column of the same VD reads the
    /// SAME allocation (`Arc::ptr_eq`) rather than re-ranking the mask. This is the "build the
    /// rank once" property at the cache seam that `mask_plan` relies on.
    ///
    /// nc: have the second read bypass the cache and build a fresh `MaskPlan` — the two Arcs no
    /// longer alias, so the rank was rebuilt.
    #[test]
    fn the_rank_is_built_once_and_shared_across_columns() {
        let cache = super::super::gathered::ResolutionCache::<MaskPlan>::new(1024 * 1024);
        let key = "mask-abc|sha256:deadbeef";
        let built = std::sync::Arc::new(MaskPlan::from_keep(vec![true, false, true]));
        cache.put(key, std::sync::Arc::clone(&built), built.footprint_bytes());

        // Column 1 and column 2 of the same VD both resolve the mask through the cache.
        let col1 = cache.get(key).expect("column 1 finds the built rank");
        let col2 = cache.get(key).expect("column 2 reuses it");
        assert!(
            std::sync::Arc::ptr_eq(&col1, &col2),
            "both columns share ONE MaskPlan — the rank was built once, not per column"
        );
        assert!(std::sync::Arc::ptr_eq(&col1, &built));
    }
}
