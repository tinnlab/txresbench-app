//! The registry-enriched per-artifact catalog view (ITEM-20): a P1 `artifacts` row
//! ⊗ the P2 registry → the datatype descriptor + resolved viewers + capabilities the
//! FE canvas / AI planner need. READ path — fail-soft on an unknown datatype (DEC-2):
//! a stale row referencing an uninstalled-extension datatype yields a generic
//! "unknown" view, not a 500.
//!
//! **artifact-model ITEM-14** removed `default_tier` + `selector_tiers` from this
//! view. They told the FE which TRANSPORT to use per selector (server layout-slice vs
//! client range-decode); ITEM-12 left exactly one transport, so the answer was a
//! constant dressed as a decision.

use schemars::JsonSchema;
use serde::Serialize;

use crate::modules::workstore::catalog::models::Artifact;

use super::registry::DatatypeRegistry;
use super::types::{Datatype, ViewerRef};

/// One artifact enriched with its datatype meaning.
#[derive(Debug, Serialize, JsonSchema)]
pub struct ArtifactCatalog {
    pub artifact: Artifact,
    /// The resolved datatype descriptor; `null` when the datatype is not registered
    /// (fail-soft — a stale / uninstalled-extension datatype).
    pub datatype: Option<Datatype>,
    /// `true` when the datatype is unknown (the FE renders a generic "unknown" card).
    pub unknown: bool,
    /// Viewers resolved UP the lattice (empty when unknown).
    pub viewers: Vec<ViewerRef>,
    /// The datatype's capabilities (empty when unknown).
    pub capabilities: Vec<String>,
}

impl ArtifactCatalog {
    pub fn build(registry: &DatatypeRegistry, artifact: Artifact) -> Self {
        match registry.get(&artifact.datatype) {
            Some(dt) => {
                let viewers = registry.viewers_for(&artifact.datatype);
                let capabilities = dt.capabilities.clone();
                ArtifactCatalog {
                    artifact,
                    datatype: Some(dt.clone()),
                    unknown: false,
                    viewers,
                    capabilities,
                }
            }
            None => ArtifactCatalog {
                artifact,
                datatype: None,
                unknown: true,
                viewers: vec![],
                capabilities: vec![],
            },
        }
    }
}
