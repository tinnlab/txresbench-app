//! **Are an artifact's bytes still in the store?** — a READ-ONLY answer.
//!
//! `artifacts.status = 'ready'` records that INGEST succeeded. It says nothing about
//! whether the blobs the row names are still on disk, and the two came apart on a live
//! project: 89 artifacts, every one `ready`, and every one of the 83 distinct blobs they
//! referenced absent from the store (freed by a cross-worktree GC that has since been
//! fixed by partitioning). Every read answered `404 Blob`, every plot came back empty, and
//! the API had no way to say why — `GET /artifacts/{id}` reported a healthy row for each.
//!
//! The information is cheap: the GC sweep already walks both sides of exactly this
//! question (the catalog's keep-set against the store's contents). What was missing was
//! anyone ASKING it on the read side.
//!
//! ## Why a report, and not a status transition
//!
//! Three shapes were available — a read-only report, a status transition on read failure,
//! or a per-artifact health probe. This is the report, deliberately:
//!
//! * **A status transition would be a write on a read path, and an irreversible one.**
//!   `status` is the conformance gate's verdict about the BYTES ("they disagree with the
//!   `structure` their producer declared" — see [`super::consume`]), and it is what
//!   [`ConsumableArtifact`](super::consume::ConsumableArtifact) refuses on. Writing it
//!   here would say something false: an absent blob is no evidence the bytes were ever
//!   wrong. It would also be self-inflicted data loss of the recoverable kind — an
//!   operator who restores a store, remounts a volume, or fixes a misconfigured root gets
//!   their artifacts back, unless a read has meanwhile condemned all 89 of them.
//! * **Absence is not always a fault.** An operator pruning a cache, a partial restore, a
//!   store pointed at the wrong root — all produce it. So this module reports that the
//!   bytes are not here and stops. It never says who removed them, because it does not
//!   know, and in the common case nothing did anything wrong.
//! * **A per-artifact probe answers the wrong question.** The owner in the incident did
//!   not need to know about one artifact; they needed the SHAPE of it — which is why the
//!   surface is a project-scoped report with counts.
//!
//! ## Uncertainty is never reported as absence
//!
//! [`ObjectStore::exists`] answers `Ok(false)` for a genuine `ENOENT` and `Err` for
//! everything else (`EMFILE`, `EACCES`, `EIO`) — a distinction `local_fs::map_blob_io_err`
//! preserves on purpose, because a sweep walking the whole pool is exactly when file
//! descriptors run out. This module inherits it: a store fault becomes
//! [`BytesPresence::Indeterminate`], never [`BytesPresence::Absent`]. Telling an owner
//! their data is gone because a read momentarily failed is the same class of mistake as
//! the GC freeing a blob whose manifest it could not read — and that one cost real data.

use serde::Serialize;
use uuid::Uuid;

use super::catalog::models::Artifact;
use super::object_store::{decode_manifest, ContentKey, ObjectStore};

/// Whether the bytes a catalog row names are in the object store right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BytesPresence {
    /// Every blob this artifact names is in the store.
    Present,
    /// Something this artifact names is not in the store. The variant says WHAT, because
    /// "your artifact is broken" is not actionable and "the member `c/0` it names is not
    /// here" is.
    Absent(AbsentPart),
    /// The store could not answer. **Not an absence** — see the module docs.
    Indeterminate(String),
}

/// WHICH of an artifact's blobs is not in the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AbsentPart {
    /// A single-file artifact's one blob.
    Object,
    /// A multi-file artifact's MANIFEST blob — so no member of it can even be named.
    Manifest,
    /// The manifest is here and resolvable, but a member path it names is not.
    Member(String),
}

impl BytesPresence {
    /// The wire word: `present` | `absent` | `indeterminate`.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::Absent(_) => "absent",
            Self::Indeterminate(_) => "indeterminate",
        }
    }

    /// A plain-language explanation for a person reading the report.
    ///
    /// The vocabulary is deliberate and is asserted by
    /// `tests/workstore/blob_presence_test.rs`: it says the bytes are **not in this
    /// store**, and it never says they were deleted, lost or corrupted. This code cannot
    /// know any of those things, and the most common causes are nobody's fault.
    pub fn detail(&self) -> String {
        match self {
            Self::Present => "the bytes this artifact names are in this store".to_string(),
            Self::Absent(AbsentPart::Object) => {
                "the bytes this artifact names are not in this store".to_string()
            }
            Self::Absent(AbsentPart::Manifest) => {
                "the manifest naming this artifact's members is not in this store, so none \
                 of its members can be resolved"
                    .to_string()
            }
            Self::Absent(AbsentPart::Member(path)) => format!(
                "this artifact's manifest is in this store, but a member it names is not: {path}"
            ),
            Self::Indeterminate(cause) => format!(
                "whether this artifact's bytes are in this store could not be determined: {cause}"
            ),
        }
    }
}

/// Ask the store whether every blob `artifact` names is present.
///
/// **Read-only by construction**: the only store methods it can reach are
/// [`ObjectStore::exists`] and [`ObjectStore::get`] (of a manifest blob). It holds no
/// pool, so it cannot write a row either.
///
/// A multi-file artifact is checked THROUGH its manifest — a manifest that is present
/// says nothing about the chunks behind it, and calling such an artifact healthy is
/// exactly the miss that would have made this report useless for the incident it was
/// written for (a Zarr artifact whose members were freed). Members are checked in the
/// manifest's own (sorted) order and the walk STOPS at the first one that is not here:
/// the report is a diagnosis, not an inventory, and one named absence is enough to
/// explain an empty plot.
pub async fn presence_of(store: &dyn ObjectStore, artifact: &Artifact) -> BytesPresence {
    // ITEM-16 — a GATHERED artifact names no blob, so "are its bytes in the store" is not
    // a question the store can answer. `Indeterminate` is exact here rather than a
    // placeholder: it is documented as "the store could not answer — NOT an absence", and
    // reporting `Absent` would be a false diagnosis that reads as corruption.
    //
    // The question a user actually means for a gathered artifact — "can this be read?" —
    // is about its SOURCES, and answering it needs the chain resolver (ITEM-21/29).
    let Some(key) = artifact.object_key.as_deref() else {
        return BytesPresence::Indeterminate(format!(
            "artifact {} is GATHERED (no stored bytes); its readability is a question about \
             the alignment's source datasets, which ITEM-21/29 answers",
            artifact.id
        ));
    };
    presence_of_key(store, key, artifact.is_multifile).await
}

/// The same question asked of a bare `(object_key, is_multifile)` pair rather than a full
/// catalog row — the whole of [`presence_of`]'s logic, which delegates here.
///
/// It exists because the GC sweep asks exactly this question and holds exactly this much:
/// when [`super::gc`] cannot enumerate a multi-file artifact's members it needs to explain
/// WHY, and "the manifest naming this artifact's members is not in this store" is an
/// answer this module already knows how to give. Splitting the row off is what lets the
/// sweep reuse the vocabulary instead of inventing a second one — including the rule that
/// matters most here, that a store fault is [`BytesPresence::Indeterminate`] and never an
/// absence.
pub async fn presence_of_key(
    store: &dyn ObjectStore,
    object_key: &str,
    is_multifile: bool,
) -> BytesPresence {
    let key = ContentKey::parse(object_key);
    match store.exists(&key).await {
        Ok(false) => {
            return BytesPresence::Absent(if is_multifile {
                AbsentPart::Manifest
            } else {
                AbsentPart::Object
            })
        }
        Err(e) => return BytesPresence::Indeterminate(e.to_string()),
        Ok(true) => {}
    }
    if !is_multifile {
        return BytesPresence::Present;
    }
    // The manifest is here — read it and check what it names.
    let bytes = match store.get(&key).await {
        Ok(b) => b,
        Err(e) => return BytesPresence::Indeterminate(e.to_string()),
    };
    let members = match decode_manifest(&bytes) {
        Ok(m) => m,
        Err(e) => return BytesPresence::Indeterminate(e.to_string()),
    };
    for (path, member_key) in members {
        match store.exists(&ContentKey::parse(&member_key)).await {
            Ok(true) => {}
            Ok(false) => return BytesPresence::Absent(AbsentPart::Member(path)),
            Err(e) => return BytesPresence::Indeterminate(e.to_string()),
        }
    }
    BytesPresence::Present
}

/// One artifact the report has something to say about.
///
/// Only rows whose bytes are NOT confirmed present appear here — a report that listed
/// every row would be indistinguishable from one that checked nothing. The counts on
/// [`BytesPresenceReport`] carry the rest.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ArtifactBytesRow {
    pub artifact_id: Uuid,
    /// The producer's own id for this output — how a user recognises it.
    pub output_id: String,
    pub datatype: String,
    /// The artifact's content identity, so an operator restoring a store can match it up.
    pub content_hash: String,
    pub is_multifile: bool,
    /// `absent` | `indeterminate`. Never `present` (those rows are not listed).
    pub presence: String,
    /// A plain-language explanation naming what is not here. Says the bytes are not in
    /// this store; never asserts that anything removed them.
    pub detail: String,
}

/// A project's artifact-bytes report.
///
/// `checked` is every row examined; the three counters partition it. **`absent > 0` is a
/// STORAGE observation, not a verdict on the artifacts** — the catalog rows are untouched
/// and still `ready`, and they become readable again the moment their bytes are back.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct BytesPresenceReport {
    pub project_id: Uuid,
    pub checked: i64,
    pub present: i64,
    pub absent: i64,
    /// Rows the store could not answer for. Deliberately its own counter rather than being
    /// folded into `absent`: "I could not look" and "it is not here" are different facts,
    /// and only one of them is about your data.
    pub indeterminate: i64,
    pub artifacts: Vec<ArtifactBytesRow>,
}

impl BytesPresenceReport {
    /// Fold one artifact's verdict into the report.
    pub fn record(&mut self, artifact: &Artifact, presence: BytesPresence) {
        self.checked += 1;
        match presence {
            BytesPresence::Present => {
                self.present += 1;
                return;
            }
            BytesPresence::Absent(_) => self.absent += 1,
            BytesPresence::Indeterminate(_) => self.indeterminate += 1,
        }
        self.artifacts.push(ArtifactBytesRow {
            artifact_id: artifact.id,
            output_id: artifact.output_id.clone(),
            datatype: artifact.datatype.clone(),
            content_hash: artifact.content_hash.clone(),
            is_multifile: artifact.is_multifile,
            presence: presence.label().to_string(),
            detail: presence.detail(),
        });
    }

    pub fn empty(project_id: Uuid) -> Self {
        Self {
            project_id,
            checked: 0,
            present: 0,
            absent: 0,
            indeterminate: 0,
            artifacts: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::workstore::object_store::{
        BlobLink, ByteStream, GcReport, LocalFsStore, MultiFilePut, ObjectStat,
    };
    use chrono::Utc;
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use txresbench_core::AppError;

    fn tmp_store() -> (PathBuf, LocalFsStore) {
        let dir = std::env::temp_dir().join(format!("txr-presence-{}", Uuid::new_v4()));
        (dir.clone(), LocalFsStore::new(dir))
    }

    fn row(object_key: &str, is_multifile: bool) -> Artifact {
        Artifact {
            id: Uuid::new_v4(),
            project_id: Some(Uuid::new_v4()),
            dataset_id: None,
            run_id: Some(Uuid::new_v4()),
            output_id: "expression".into(),
            datatype: "single-cell/expression".into(),
            object_key: Some(object_key.into()),
            is_multifile,
            content_hash: object_key.into(),
            structure: serde_json::json!({ "encoding": "opaque" }),
            meta: serde_json::json!({}),
            role: "artifact".into(),
            status: "ready".into(),
            stored_bytes: 1,
            logical_bytes: Some(1),
            created_by: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            hidden: false,
            representation_of: None,
        }
    }

    /// POSITIVE CONTROL. Without it every "absent" assertion below would hold just as well
    /// for a checker that answered `Absent` unconditionally.
    #[tokio::test]
    async fn a_single_file_artifact_whose_blob_is_here_is_present() {
        let (dir, store) = tmp_store();
        let key = store.put(b"the bytes").await.unwrap();
        assert_eq!(
            presence_of(&store, &row(key.as_str(), false)).await,
            BytesPresence::Present
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_single_file_artifact_whose_bytes_are_not_here_is_absent() {
        let (dir, store) = tmp_store();
        let never_stored = format!("sha256:{}", "a".repeat(64));
        let got = presence_of(&store, &row(&never_stored, false)).await;
        assert_eq!(got, BytesPresence::Absent(AbsentPart::Object));
        assert!(
            got.detail().contains("not in this store"),
            "{}",
            got.detail()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_multifile_artifact_whose_manifest_is_not_here_is_absent() {
        let (dir, store) = tmp_store();
        let never_stored = format!("sha256:{}", "c".repeat(64));
        assert_eq!(
            presence_of(&store, &row(&never_stored, true)).await,
            BytesPresence::Absent(AbsentPart::Manifest)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The check that makes this report worth having.** A multi-file artifact's manifest
    /// is a map to member blobs, so a checker that stopped at the manifest would call the
    /// incident's Zarr artifacts healthy while every chunk behind them was gone. The
    /// control (all members here → `Present`) runs on the same store, one line earlier.
    #[tokio::test]
    async fn a_multifile_artifact_is_absent_when_a_member_is_not_here_and_it_names_which() {
        let (dir, store) = tmp_store();
        let put = store
            .put_prefix(&[
                ("zarr.json".to_string(), b"{\"shape\":[2]}".to_vec()),
                ("c/0".to_string(), b"CHUNK-ZERO".to_vec()),
                ("c/1".to_string(), b"CHUNK-ONE".to_vec()),
            ])
            .await
            .unwrap();
        let artifact = row(put.object_key.as_str(), true);

        assert_eq!(
            presence_of(&store, &artifact).await,
            BytesPresence::Present,
            "control: with every member here the artifact is present"
        );

        let member = put.members.iter().find(|m| m.path == "c/1").unwrap();
        store.delete(&member.blob).await.unwrap();
        assert!(
            store.exists(&put.object_key).await.unwrap(),
            "the manifest is still here — a checker that stopped at it would say Present"
        );

        let got = presence_of(&store, &artifact).await;
        assert_eq!(got, BytesPresence::Absent(AbsentPart::Member("c/1".into())));
        assert!(got.detail().contains("c/1"), "{}", got.detail());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A store that answers a NON-absence fault (the `EMFILE` shape — the blob may well be
    /// right there, the read just could not be served). Mirrors `gc.rs`'s
    /// `FailingManifestStore`, and for the same reason: a transient failure must never be
    /// able to present itself as an absence.
    struct FaultingStore {
        inner: LocalFsStore,
        fault_key: String,
    }

    #[async_trait::async_trait]
    impl ObjectStore for FaultingStore {
        fn store_root(&self) -> Option<&Path> {
            self.inner.store_root()
        }
        async fn put(&self, bytes: &[u8]) -> Result<ContentKey, AppError> {
            self.inner.put(bytes).await
        }
        async fn put_prefix(&self, m: &[(String, Vec<u8>)]) -> Result<MultiFilePut, AppError> {
            self.inner.put_prefix(m).await
        }
        async fn get(&self, key: &ContentKey) -> Result<Vec<u8>, AppError> {
            self.inner.get(key).await
        }
        async fn get_range(
            &self,
            key: &ContentKey,
            offset: u64,
            length: u64,
        ) -> Result<Vec<u8>, AppError> {
            self.inner.get_range(key, offset, length).await
        }
        async fn get_stream(
            &self,
            key: &ContentKey,
            offset: u64,
            length: u64,
        ) -> Result<ByteStream, AppError> {
            self.inner.get_stream(key, offset, length).await
        }
        async fn link_blob(&self, key: &ContentKey, dest: &Path) -> BlobLink {
            self.inner.link_blob(key, dest).await
        }
        async fn stat(&self, key: &ContentKey) -> Result<ObjectStat, AppError> {
            self.inner.stat(key).await
        }
        async fn exists(&self, key: &ContentKey) -> Result<bool, AppError> {
            if key.as_str() == self.fault_key {
                return Err(AppError::internal_error(
                    "workstore: blob read failed: Too many open files (os error 24)",
                ));
            }
            self.inner.exists(key).await
        }
        /// The read-only guard: a presence check has no business unlinking anything, so if
        /// it ever calls this the test dies rather than passing quietly.
        async fn delete(&self, _key: &ContentKey) -> Result<(), AppError> {
            panic!("a presence REPORT deleted a blob — it must never write to the store");
        }
        async fn resolve_member(
            &self,
            manifest_key: &ContentKey,
            member_path: &str,
        ) -> Result<ContentKey, AppError> {
            self.inner.resolve_member(manifest_key, member_path).await
        }
        async fn gc(&self, keep: &HashSet<String>, min_age: u64) -> Result<GcReport, AppError> {
            self.inner.gc(keep, min_age).await
        }
    }

    /// **Uncertainty is not absence.** A store fault must report `indeterminate`, with the
    /// cause preserved, and must NOT be counted as "your bytes are gone".
    #[tokio::test]
    async fn a_store_fault_is_indeterminate_never_absent() {
        let (dir, inner) = tmp_store();
        let key = inner
            .put(b"present, but unreadable right now")
            .await
            .unwrap();
        let store = FaultingStore {
            inner,
            fault_key: key.as_str().to_string(),
        };

        let got = presence_of(&store, &row(key.as_str(), false)).await;
        match &got {
            BytesPresence::Indeterminate(cause) => assert!(
                cause.contains("Too many open files"),
                "the cause survives to the operator: {cause}"
            ),
            other => panic!(
                "a read fault must not be reported as an absence — the blob IS there: {other:?}"
            ),
        }
        assert_eq!(got.label(), "indeterminate");
        assert!(
            !got.detail().to_lowercase().contains("not in this store"),
            "an indeterminate row must not read like an absent one: {}",
            got.detail()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The report is an EXCEPTION list: a present row moves a counter and adds no entry.
    #[test]
    fn the_report_counts_every_row_but_lists_only_the_ones_it_has_something_to_say_about() {
        let project = Uuid::new_v4();
        let mut report = BytesPresenceReport::empty(project);
        report.record(&row("sha256:aa", false), BytesPresence::Present);
        report.record(
            &row("sha256:bb", false),
            BytesPresence::Absent(AbsentPart::Object),
        );
        report.record(
            &row("sha256:cc", true),
            BytesPresence::Indeterminate("EMFILE".into()),
        );

        assert_eq!(report.checked, 3);
        assert_eq!(
            (report.present, report.absent, report.indeterminate),
            (1, 1, 1)
        );
        assert_eq!(
            report.artifacts.len(),
            2,
            "the present row is counted, not listed"
        );
        assert_eq!(report.artifacts[0].presence, "absent");
        assert_eq!(report.artifacts[1].presence, "indeterminate");
        assert!(report.artifacts[1].detail.contains("EMFILE"));
    }
}
