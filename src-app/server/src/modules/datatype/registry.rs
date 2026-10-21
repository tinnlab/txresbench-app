//! The datatype registry: subtyping lattice + type-match gating + viewer dispatch
//! (ITEM-2/3/4/19). A direct mirror of `project::core::extension::registry`'s
//! `linkme::distributed_slice` + hot-swappable `ArcSwapOption` fold-at-boot pattern —
//! built-ins self-register via `#[distributed_slice(DATATYPES)]`, folded into a
//! process-wide `DatatypeRegistry` at module `init`, published into an `ArcSwapOption`
//! so a rescan (S6/S7) can atomically re-publish without a restart (INV-2). Open
//! replacement for a closed `DataKind` enum.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arc_swap::ArcSwapOption;
use linkme::distributed_slice;

use crate::modules::workstore::catalog::models::Artifact;

use super::types::{AxisSpec, Datatype, FileLayout, TypeSelector, ViewerRef};

/// A per-type shape validator (DEC-12): checks the `shape` JSONB has the required
/// keys/types. `Ok(())` for types with no shape constraint.
pub type ShapeFn = fn(&serde_json::Value) -> Result<(), String>;

/// A datatype's shape validator (ITEM-2 / DEC-6). A code-seeded datatype ships a Rust
/// fn-pointer (`Fn`); a MANIFEST-contributed datatype ships its declarative `schema`
/// (`Schema`) — a bare `fn` cannot close over a per-type schema, so the store carries the
/// schema value and the hand-rolled subset validator ([`validate_against_schema`])
/// interprets it at check time. A schemaless contribution (empty / non-object schema)
/// accepts anything, preserving the former manifest no-op behaviour.
enum Validator {
    /// A code-seeded Rust validator fn (`builtin.rs`).
    Fn(ShapeFn),
    /// A manifest-declared JSON-schema-subset document, enforced at `validate_shape`.
    Schema(serde_json::Value),
}

/// A hand-rolled JSON-schema SUBSET validator (ITEM-2 / DEC-6): `type` / `required` /
/// `properties` / `items` — enough to enforce the contributed datatypes' declared shapes
/// WITHOUT a json-schema dependency (§17), mirroring the style of `builtin.rs`'s
/// `validate_matrix_shape`. A schema with NO constraints (empty object, or a non-object
/// like `null`/`true`) accepts any value, so a schemaless manifest contribution is a
/// no-op (never rejects), while a declared `{type,required,properties}` REJECTS a bad shape.
fn validate_against_schema(
    schema: &serde_json::Value,
    value: &serde_json::Value,
) -> Result<(), String> {
    let Some(obj) = schema.as_object() else {
        return Ok(()); // non-object schema imposes no constraint
    };
    if obj.is_empty() {
        return Ok(()); // `{}` imposes no constraint (the schemaless no-op)
    }
    // `type` — enforce the JSON kind when declared.
    if let Some(ty) = obj.get("type").and_then(|t| t.as_str()) {
        let ok = match ty {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "integer" => value.is_i64() || value.is_u64(),
            "number" => value.is_number(),
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            _ => true, // unknown type keyword: don't reject (subset is permissive)
        };
        if !ok {
            return Err(format!(
                "expected type `{ty}`, got `{}`",
                json_type_name(value)
            ));
        }
    }
    // `minimum` — reject a number below the declared bound (ITEM-2 / A1). Restores
    // the non-negative constraint the former `validate_matrix_shape` enforced via
    // `!v.is_u64()`: the contributed matrix-family count fields declare
    // `{ type: integer, minimum: 0 }`, so a NEGATIVE `cells`/`genes` is REJECTED
    // where the bare `{ type: integer }` (is_i64 || is_u64) would have accepted it.
    if let Some(min) = obj.get("minimum").and_then(|m| m.as_f64()) {
        if let Some(n) = value.as_f64() {
            if n < min {
                return Err(format!("value {n} is below the minimum {min}"));
            }
        }
    }
    // `required` — every named key must be present (only meaningful on an object value).
    if let Some(req) = obj.get("required").and_then(|r| r.as_array()) {
        if let Some(vobj) = value.as_object() {
            for key in req.iter().filter_map(|k| k.as_str()) {
                if !vobj.contains_key(key) {
                    return Err(format!("missing required property `{key}`"));
                }
            }
        }
    }
    // `properties` — recurse into each declared property that is PRESENT on the value.
    if let Some(props) = obj.get("properties").and_then(|p| p.as_object()) {
        if let Some(vobj) = value.as_object() {
            for (key, subschema) in props {
                if let Some(subval) = vobj.get(key) {
                    validate_against_schema(subschema, subval)
                        .map_err(|e| format!("property `{key}`: {e}"))?;
                }
            }
        }
    }
    // `items` — recurse into every array element.
    if let Some(items) = obj.get("items") {
        if let Some(arr) = value.as_array() {
            for (i, el) in arr.iter().enumerate() {
                validate_against_schema(items, el).map_err(|e| format!("item[{i}]: {e}"))?;
            }
        }
    }
    Ok(())
}

fn json_type_name(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// A self-registering built-in datatype (mirror of `ProjectExtensionEntry`).
#[derive(Clone, Copy)]
pub struct DatatypeEntry {
    pub id: &'static str,
    pub extends: Option<&'static str>,
    pub constructor: fn() -> Datatype,
    pub validate_shape: ShapeFn,
}

/// The distributed slice every built-in registers into. Declaring
/// `pub mod datatype;` (in `modules/mod.rs`) links these.
#[distributed_slice]
pub static DATATYPES: [DatatypeEntry] = [..];

/// The folded, validated registry.
pub struct DatatypeRegistry {
    types: HashMap<String, Datatype>,
    validators: HashMap<String, Validator>,
}

impl DatatypeRegistry {
    /// Build from every `#[distributed_slice(DATATYPES)]` entry. Fails (→ boot
    /// failure) on a malformed lattice.
    pub fn build_from_slice() -> Result<Self, String> {
        Self::from_entries(DATATYPES.iter().copied())
    }

    /// Build from an explicit set of entries (the testable core). Delegates to
    /// [`merge_entries`](Self::merge_entries) with no manifest-contributed extras.
    pub fn from_entries(entries: impl IntoIterator<Item = DatatypeEntry>) -> Result<Self, String> {
        Self::merge_entries(entries, Vec::new())
    }

    /// Build from the Rust `#[distributed_slice(DATATYPES)]` built-ins PLUS a set of
    /// MANIFEST-contributed datatypes (ITEM-1 / DEC-19) — the modular seam: an
    /// extension folder contributes a whole domain (datatypes + axes) with ZERO core
    /// edit. A contributed id that COLLIDES with a Rust-registered datatype is a boot
    /// failure (fail loud): a manifest may EXTEND the lattice, never silently shadow a
    /// core root. Manifest datatypes register with a no-op shape validator (their
    /// declarative `schema` is the validator, DEC-21).
    pub fn build_merged(extra: Vec<Datatype>) -> Result<Self, String> {
        Self::merge_entries(DATATYPES.iter().copied(), extra)
    }

    /// Build the FULL registry exactly as boot does: the Rust lattice ROOTS
    /// (`#[distributed_slice(DATATYPES)]`) UNION every datatype CONTRIBUTED by the
    /// embedded `src-app/packages/*/manifest.yaml` tree (ITEM-5). This is the ONE
    /// builder both [`DatatypeModule::init`](crate::modules::datatype::DatatypeModule)
    /// and the datatype tests use, so a test observes the SAME merged lattice
    /// production serves (the roots-only `build_from_slice` is no longer the whole
    /// picture — the domain datatypes live in contributed manifests). Fails (→ boot
    /// failure) on a malformed manifest or an invalid merged lattice.
    pub fn build_from_embedded() -> Result<Self, String> {
        let extra = crate::modules::extensions::contributed_datatypes_from_embedded()?;
        Self::build_merged(extra)
    }

    /// The shared fold over the Rust built-in entries + the manifest-contributed
    /// `extra` datatypes. The two sources are disjoint by id (a collision is an error);
    /// the folded registry is then lattice-validated.
    pub fn merge_entries(
        entries: impl IntoIterator<Item = DatatypeEntry>,
        extra: Vec<Datatype>,
    ) -> Result<Self, String> {
        let mut types: HashMap<String, Datatype> = HashMap::new();
        let mut validators: HashMap<String, Validator> = HashMap::new();
        for e in entries {
            let dt = (e.constructor)();
            if dt.id != e.id {
                return Err(format!(
                    "datatype entry id `{}` != constructed id `{}`",
                    e.id, dt.id
                ));
            }
            if types.insert(dt.id.clone(), dt).is_some() {
                return Err(format!("duplicate datatype id `{}`", e.id));
            }
            // A code-seeded datatype ships its Rust fn-pointer validator.
            validators.insert(e.id.to_string(), Validator::Fn(e.validate_shape));
        }
        for dt in extra {
            if types.contains_key(&dt.id) {
                return Err(format!(
                    "manifest-contributed datatype `{}` collides with a Rust-registered \
                     datatype id (a manifest may extend the lattice, never shadow a core type)",
                    dt.id
                ));
            }
            // A manifest-contributed datatype's declared `schema` IS its validator (DEC-6):
            // compiled into an ENFORCED shape check (no-op only when the schema is empty).
            let id = dt.id.clone();
            let schema = dt.schema.clone();
            types.insert(id.clone(), dt);
            validators.insert(id, Validator::Schema(schema));
        }
        let reg = Self { types, validators };
        reg.validate()?;
        Ok(reg)
    }

    /// Merge AXIS overlays onto already-registered datatypes (ITEM-3 / DEC-15): a
    /// manifest may declare the axes of an EXISTING Rust datatype (e.g. attach
    /// `cells`/`genes` to the Rust-registered `single-cell/anndata`) WITHOUT
    /// redefining it — the loader merges the axes onto the registry entry. An overlay
    /// targeting an unknown id is an error; a target that ALREADY declares axes is an
    /// error (no silent double-declare). Called after [`build_merged`](Self::build_merged),
    /// before publishing the singleton.
    pub fn attach_axes(&mut self, overlays: Vec<(String, Vec<AxisSpec>)>) -> Result<(), String> {
        for (id, axes) in overlays {
            let dt = self
                .types
                .get_mut(&id)
                .ok_or_else(|| format!("axis overlay targets unknown datatype id `{id}`"))?;
            if !dt.axes.is_empty() {
                return Err(format!(
                    "datatype `{id}` already declares axes; refusing to overlay a second set"
                ));
            }
            dt.axes = axes;
        }
        Ok(())
    }

    /// The declared entity axes of a datatype (ITEM-3). Empty for a datatype with none.
    pub fn axes_for(&self, datatype: &str) -> Vec<AxisSpec> {
        self.types
            .get(datatype)
            .map(|d| d.axes.clone())
            .unwrap_or_default()
    }

    /// Validate the lattice: every `extends` resolves, no self-extend, no cycle,
    /// exactly one root. Called at build; a failure fails boot with a clear message.
    pub fn validate(&self) -> Result<(), String> {
        let mut roots = 0usize;
        for dt in self.types.values() {
            match &dt.extends {
                None => roots += 1,
                Some(parent) => {
                    if parent == &dt.id {
                        return Err(format!("datatype `{}` extends itself", dt.id));
                    }
                    if !self.types.contains_key(parent) {
                        return Err(format!(
                            "datatype `{}` extends unknown supertype `{}`",
                            dt.id, parent
                        ));
                    }
                }
            }
        }
        if self.types.is_empty() {
            // An empty registry is valid (the no-op / empty-slice case).
            return Ok(());
        }
        if roots != 1 {
            return Err(format!(
                "datatype lattice must have exactly one root (extends: none); found {roots}"
            ));
        }
        // Cycle detection: walking `extends` from every node must terminate at the root.
        for dt in self.types.values() {
            let mut seen: HashSet<&str> = HashSet::new();
            let mut cur = dt.id.as_str();
            loop {
                if !seen.insert(cur) {
                    return Err(format!("cycle in datatype lattice at `{}`", dt.id));
                }
                match self.types.get(cur).and_then(|d| d.extends.as_deref()) {
                    Some(parent) => cur = parent,
                    None => break,
                }
            }
        }
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&Datatype> {
        self.types.get(id)
    }

    /// All datatypes, ordered by id for a stable dump.
    pub fn all(&self) -> Vec<&Datatype> {
        let mut v: Vec<&Datatype> = self.types.values().collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    pub fn len(&self) -> usize {
        self.types.len()
    }

    pub fn is_empty(&self) -> bool {
        self.types.is_empty()
    }

    /// `sub is_a sup` — reflexive + walks the `extends` chain (ITEM-3). Compatibility
    /// = this (the Galaxy lattice rule: `single-cell/expression is_a matrix`).
    pub fn is_a(&self, sub: &str, sup: &str) -> bool {
        if sub == sup {
            return self.types.contains_key(sub);
        }
        let mut cur = sub;
        let mut guard = 0usize;
        while let Some(parent) = self.types.get(cur).and_then(|d| d.extends.as_deref()) {
            if parent == sup {
                return true;
            }
            cur = parent;
            guard += 1;
            if guard > self.types.len() {
                return false; // defensive: a validated lattice never loops
            }
        }
        false
    }

    /// Proper supertypes of `id`, nearest first (`[matrix, tabular, data]`).
    pub fn ancestors(&self, id: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = id;
        let mut guard = 0usize;
        while let Some(parent) = self.types.get(cur).and_then(|d| d.extends.as_deref()) {
            out.push(parent.to_string());
            cur = parent;
            guard += 1;
            if guard > self.types.len() {
                break;
            }
        }
        out
    }

    /// Proper subtypes of `id` (every type whose ancestor chain includes `id`).
    pub fn descendants(&self, id: &str) -> Vec<String> {
        let mut out: Vec<String> = self
            .types
            .keys()
            .filter(|k| k.as_str() != id && self.is_a(k, id))
            .cloned()
            .collect();
        out.sort();
        out
    }

    /// `id` + all its subtypes — the datatype allow-list for a `subtypes_of` filter.
    pub fn descendants_inclusive(&self, id: &str) -> Vec<String> {
        let mut out = vec![id.to_string()];
        out.extend(self.descendants(id));
        out.sort();
        out.dedup();
        out
    }

    /// Every datatype id advertising `cap`.
    pub fn types_with_capability(&self, cap: &str) -> Vec<String> {
        let mut out: Vec<String> = self
            .types
            .values()
            .filter(|d| d.has_capability(cap))
            .map(|d| d.id.clone())
            .collect();
        out.sort();
        out
    }

    /// Does an artifact of `datatype` satisfy `selector` (ITEM-4)? = subtype/exact
    /// match ∧ capability subset. An unknown datatype never matches a typed selector.
    pub fn matches(&self, datatype: &str, selector: &TypeSelector) -> bool {
        let Some(dt) = self.types.get(datatype) else {
            return false;
        };
        let base = match (&selector.subtypes_of, &selector.type_id) {
            (Some(sup), _) => self.is_a(datatype, sup),
            (None, Some(exact)) => datatype == exact,
            (None, None) => true, // capability-only selector matches any known type
        };
        // ITEM-19: reject a datatype that `is_a` any excluded id ("subtypes of X except Y").
        let excluded = selector.excludes.iter().any(|e| self.is_a(datatype, e));
        base && !excluded && selector.capabilities.iter().all(|c| dt.has_capability(c))
    }

    /// Filter a slice of artifacts to those whose datatype satisfies `selector`
    /// (drives the Tier-2 artifact-ref picker; PLATFORM §4.3).
    pub fn compatible_artifacts<'a>(
        &self,
        selector: &TypeSelector,
        artifacts: &'a [Artifact],
    ) -> Vec<&'a Artifact> {
        artifacts
            .iter()
            .filter(|a| self.matches(&a.datatype, selector))
            .collect()
    }

    /// Resolve a datatype's viewers UP the lattice (a supertype viewer covers a
    /// subtype; DEC-7/DEC-8). Self first, then ancestors, deduped by `view_kind_id`.
    pub fn viewers_for(&self, datatype: &str) -> Vec<ViewerRef> {
        let mut out: Vec<ViewerRef> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut chain = vec![datatype.to_string()];
        chain.extend(self.ancestors(datatype));
        for id in chain {
            if let Some(dt) = self.types.get(&id) {
                for v in &dt.viewers {
                    if seen.insert(v.view_kind_id.clone()) {
                        out.push(v.clone());
                    }
                }
            }
        }
        out
    }

    /// The declared physical file layout for a datatype (ITEM-14).
    pub fn file_layout_for(&self, datatype: &str) -> Option<FileLayout> {
        self.types
            .get(datatype)
            .map(|d| d.storage.file_layout.clone())
    }

    /// Run a datatype's shape validator over an artifact's `shape` JSONB (DEC-12).
    pub fn validate_shape(&self, datatype: &str, shape: &serde_json::Value) -> Result<(), String> {
        match self.validators.get(datatype) {
            Some(Validator::Fn(f)) => f(shape),
            Some(Validator::Schema(schema)) => validate_against_schema(schema, shape),
            None => Ok(()),
        }
    }

    /// Build from plain `Datatype`s (no per-type validators). Test-only helper for
    /// exercising the lattice logic on synthetic lattices without `fn`-pointer entries.
    #[cfg(test)]
    pub(crate) fn from_types(types: Vec<Datatype>) -> Result<Self, String> {
        let mut map: HashMap<String, Datatype> = HashMap::new();
        for dt in types {
            if map.insert(dt.id.clone(), dt.clone()).is_some() {
                return Err(format!("duplicate datatype id `{}`", dt.id));
            }
        }
        let reg = Self {
            types: map,
            validators: HashMap::new(),
        };
        reg.validate()?;
        Ok(reg)
    }
}

// ------------------------- process-wide swappable singleton -------------------------

/// Hot-swappable registry holder (INV-2 enabler, S2). An `ArcSwapOption` instead of a
/// boot-once `OnceCell` so a rescan (reload endpoint S7 / watcher S6) can atomically
/// re-publish a freshly-folded registry via `set_global_registry` WITHOUT a process
/// restart. `None` before boot; every reader `load_full()`s per use, so it always sees
/// the latest whole snapshot (never a torn read during a swap).
static DATATYPE_REGISTRY: ArcSwapOption<DatatypeRegistry> = ArcSwapOption::const_empty();

/// Publish (or re-publish) the folded registry. Called at boot from
/// `DatatypeModule::init`, and again on every rescan (S6/S7). Unconditional atomic
/// store — a later call replaces the prior snapshot (no set-once panic).
pub fn set_global_registry(reg: Arc<DatatypeRegistry>) {
    DATATYPE_REGISTRY.store(Some(reg));
}

/// The process-wide registry, if boot built it. `None` before `init` (e.g. a
/// direct-repo test); callers degrade (P1's list filter treats a missing registry
/// as "no subtype expansion", never a panic).
pub fn try_registry() -> Option<Arc<DatatypeRegistry>> {
    DATATYPE_REGISTRY.load_full()
}

/// The process-wide registry. Panics if boot never built it — a programming error
/// on any request path (the module always builds it at `init`).
pub fn registry() -> Arc<DatatypeRegistry> {
    DATATYPE_REGISTRY
        .load_full()
        .expect("datatype registry not built (DatatypeModule::init must run at boot)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::datatype::types::{
        FileLayout, LayoutKind, StorageSpec, TypeSelector, ViewerRef,
    };

    fn mk(
        id: &str,
        extends: Option<&str>,
        is_abstract: bool,
        caps: &[&str],
        viewers: &[&str],
    ) -> Datatype {
        Datatype {
            id: id.into(),
            extends: extends.map(|s| s.to_string()),
            title: id.into(),
            description: String::new(),
            schema: serde_json::json!({}),
            storage: StorageSpec {
                layout: LayoutKind::OpaqueAsIs,
                format: "any".into(),
                file_layout: FileLayout::Single,
            },
            capabilities: caps.iter().map(|s| s.to_string()).collect(),
            axes: vec![],
            entity_axis: None,
            arrays: vec![],
            labels: Default::default(),
            viewers: viewers
                .iter()
                .map(|v| ViewerRef {
                    view_kind_id: v.to_string(),
                    family: "test".into(),
                    consumes: vec![],
                })
                .collect(),
            ingest: None,
            converters: vec![],
            is_abstract,
            input_requirements: None,
        }
    }

    // A concrete manifest-contributed datatype (a full `Datatype`, as
    // `DatatypeContribution::to_datatype` would produce) for the merge tests.
    fn manifest_dt(id: &str, extends: &str, axes: &[(&str, &str)]) -> Datatype {
        let mut dt = mk(id, Some(extends), false, &[], &[]);
        dt.axes = axes
            .iter()
            .map(|(name, key)| crate::modules::datatype::types::AxisSpec {
                name: name.to_string(),
                key_label: key.to_string(),
            })
            .collect();
        dt
    }

    fn lattice() -> DatatypeRegistry {
        // data → tabular → matrix → {expr, emb}; data → report
        DatatypeRegistry::from_types(vec![
            mk("data", None, true, &[], &["base"]),
            mk("tabular", Some("data"), true, &[], &[]),
            mk("matrix", Some("tabular"), true, &[], &["grid"]),
            mk(
                "expr",
                Some("matrix"),
                false,
                &["sliceable", "has-obs"],
                &[],
            ),
            mk("emb", Some("matrix"), false, &["obs-aligned"], &["scatter"]),
            mk("report", Some("data"), false, &[], &["html"]),
        ])
        .unwrap()
    }

    // TEST-1: is_a chains + ancestors/descendants.
    #[test]
    fn is_a_and_family() {
        let r = lattice();
        assert!(r.is_a("expr", "matrix"));
        assert!(r.is_a("expr", "tabular"));
        assert!(r.is_a("expr", "data"));
        assert!(r.is_a("expr", "expr"), "reflexive");
        assert!(!r.is_a("emb", "expr"));
        assert!(!r.is_a("report", "matrix"));
        assert_eq!(r.ancestors("expr"), vec!["matrix", "tabular", "data"]);
        let mut desc = r.descendants("matrix");
        desc.sort();
        assert_eq!(desc, vec!["emb", "expr"]);
        assert_eq!(
            r.descendants_inclusive("matrix"),
            vec!["emb", "expr", "matrix"]
        );
    }

    // TEST-2: lattice validation rejects cycle / orphan / dup / self-extend / multi-root.
    #[test]
    fn lattice_validation_rejections() {
        // orphan extends
        assert!(
            DatatypeRegistry::from_types(vec![mk("a", Some("ghost"), false, &[], &[])]).is_err()
        );
        // self-extend
        assert!(DatatypeRegistry::from_types(vec![mk("a", Some("a"), false, &[], &[])]).is_err());
        // multi-root (two extends:none)
        assert!(DatatypeRegistry::from_types(vec![
            mk("a", None, true, &[], &[]),
            mk("b", None, true, &[], &[]),
        ])
        .is_err());
        // cycle: a→b→a (no root at all is caught as 0 roots, but build a real 2-cycle
        // by rooting one and pointing back)
        assert!(DatatypeRegistry::from_types(vec![
            mk("root", None, true, &[], &[]),
            mk("a", Some("b"), false, &[], &[]),
            mk("b", Some("a"), false, &[], &[]),
        ])
        .is_err());
        // duplicate id
        assert!(DatatypeRegistry::from_types(vec![
            mk("root", None, true, &[], &[]),
            mk("root", Some("root"), false, &[], &[]),
        ])
        .is_err());
        // valid lattice passes
        assert!(DatatypeRegistry::from_types(vec![
            mk("root", None, true, &[], &[]),
            mk("child", Some("root"), false, &[], &[]),
        ])
        .is_ok());
    }

    // TEST-3: matches — exact vs subtypes_of vs capability subset.
    #[test]
    fn matches_gating() {
        let r = lattice();
        // subtypes_of: expr is_a matrix
        let sel = TypeSelector {
            subtypes_of: Some("matrix".into()),
            ..Default::default()
        };
        assert!(r.matches("expr", &sel));
        assert!(r.matches("emb", &sel));
        assert!(!r.matches("report", &sel));
        // exact id
        let sel = TypeSelector {
            type_id: Some("expr".into()),
            ..Default::default()
        };
        assert!(r.matches("expr", &sel));
        assert!(!r.matches("emb", &sel));
        // capability subset
        let sel = TypeSelector {
            subtypes_of: Some("matrix".into()),
            capabilities: vec!["has-obs".into()],
            ..Default::default()
        };
        assert!(r.matches("expr", &sel), "expr has has-obs");
        assert!(!r.matches("emb", &sel), "emb lacks has-obs");
        // unknown datatype never matches
        assert!(!r.matches(
            "ghost",
            &TypeSelector {
                subtypes_of: Some("matrix".into()),
                ..Default::default()
            }
        ));
        // ITEM-19: excludes — "subtypes of matrix EXCEPT emb" accepts expr, rejects emb.
        let sel = TypeSelector {
            subtypes_of: Some("matrix".into()),
            excludes: vec!["emb".into()],
            ..Default::default()
        };
        assert!(r.matches("expr", &sel), "expr is-a matrix and not excluded");
        assert!(
            !r.matches("emb", &sel),
            "emb is excluded even though it is-a matrix"
        );
    }

    // TEST-4: compatible_artifacts filters a slice.
    #[test]
    fn compatible_artifacts_filters() {
        use crate::modules::workstore::catalog::models::Artifact;
        use chrono::Utc;
        use uuid::Uuid;
        let art = |dt: &str| Artifact {
            id: Uuid::new_v4(),
            project_id: Some(Uuid::new_v4()),
            dataset_id: None,
            run_id: None,
            output_id: "o".into(),
            datatype: dt.into(),
            object_key: Some("sha256:x".into()),
            is_multifile: false,
            content_hash: "sha256:x".into(),
            structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
            meta: serde_json::json!({}),
            role: "artifact".into(),
            status: "ready".into(),
            stored_bytes: 0,
            logical_bytes: Some(0),
            created_by: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            hidden: false,
            representation_of: None,
        };
        let arts = vec![art("expr"), art("report"), art("emb")];
        let sel = TypeSelector {
            subtypes_of: Some("matrix".into()),
            ..Default::default()
        };
        let got = lattice().compatible_artifacts(&sel, &arts);
        let ids: Vec<&str> = got.iter().map(|a| a.datatype.as_str()).collect();
        assert_eq!(ids, vec!["expr", "emb"]);
    }

    // TEST-5: build_from_slice completeness + empty registry no-op.
    #[test]
    fn build_and_empty() {
        // The real seed slice builds a valid registry of EXACTLY the six universal
        // roots (DEC-2) — every domain datatype now lives in a contributed manifest,
        // so the code-only slice is roots-only (was `>= 8` when domain types seeded).
        let r = DatatypeRegistry::build_from_slice().unwrap();
        assert_eq!(
            r.len(),
            6,
            "the code-seeded slice carries only the six roots"
        );
        for root in [
            "data",
            "data/opaque",
            "tabular",
            "matrix",
            "report/html",
            "file/upload",
        ] {
            assert!(r.get(root).is_some(), "root `{root}` is code-seeded");
        }
        // An empty registry is valid (the no-op shape).
        let empty = DatatypeRegistry::from_types(vec![]).unwrap();
        assert!(empty.is_empty());
        assert!(empty.get("anything").is_none());
    }

    // TEST-16: viewers_for resolves UP the lattice, self first, deduped.
    #[test]
    fn viewers_up_the_lattice() {
        let r = lattice();
        // emb has its own `scatter`, inherits `grid` from matrix + `base` from the root.
        let v: Vec<String> = r
            .viewers_for("emb")
            .iter()
            .map(|x| x.view_kind_id.clone())
            .collect();
        assert_eq!(v, vec!["scatter", "grid", "base"]);
        // expr has none of its own → inherits `grid` (matrix) + `base` (root data).
        let v: Vec<String> = r
            .viewers_for("expr")
            .iter()
            .map(|x| x.view_kind_id.clone())
            .collect();
        assert_eq!(v, vec!["grid", "base"]);
        // report inherits `base` from data + its own `html`.
        let v: Vec<String> = r
            .viewers_for("report")
            .iter()
            .map(|x| x.view_kind_id.clone())
            .collect();
        assert_eq!(v, vec!["html", "base"]);
    }

    // ITEM-1: build_merged folds manifest-contributed datatypes in ALONGSIDE the Rust
    // built-ins — the merged registry sees both, the lattice re-validates, and a
    // contributed subtype `is_a` its Rust supertype.
    #[test]
    fn build_merged_folds_manifest_datatypes() {
        // A manifest contributes `annotation-table` (extends the Rust `tabular` root)
        // + a domain datatype declaring axes.
        let extra = vec![
            manifest_dt("annotation-table", "tabular", &[]),
            manifest_dt(
                "genomics/vcf",
                "data",
                &[("variants", "variant_id"), ("samples", "sample_id")],
            ),
        ];
        let r = DatatypeRegistry::build_merged(extra).expect("merged registry is valid");
        // Both the Rust built-ins AND the manifest datatypes resolve.
        assert!(r.get("tabular").is_some(), "Rust built-in still present");
        assert!(
            r.get("annotation-table").is_some(),
            "manifest datatype merged"
        );
        assert!(r.get("genomics/vcf").is_some());
        // The contributed type participates in the lattice.
        assert!(r.is_a("annotation-table", "tabular"));
        assert!(r.is_a("annotation-table", "data"));
        // Its declared axes are queryable.
        assert_eq!(
            r.axes_for("genomics/vcf")
                .iter()
                .map(|a| a.name.clone())
                .collect::<Vec<_>>(),
            vec!["variants", "samples"]
        );
        // A manifest datatype registers a no-op shape validator (never rejects).
        assert!(r
            .validate_shape("annotation-table", &serde_json::json!({"x": 1}))
            .is_ok());
    }

    // ITEM-1: a manifest datatype whose id COLLIDES with a Rust-registered type fails
    // loud (a manifest may extend the lattice, never shadow a core root).
    #[test]
    fn build_merged_rejects_core_collision() {
        let extra = vec![manifest_dt("tabular", "data", &[])];
        let err = DatatypeRegistry::build_merged(extra)
            .err()
            .expect("id collision with a core root must be a boot error");
        assert!(
            err.contains("collides"),
            "collision is a boot failure: {err}"
        );
    }

    // Slice-1 (ITEM-1 + ITEM-2 / DEC-6): the FOUNDATION completeness proof. A
    // `DatatypeContribution` carrying viewers + selector_map + input_requirements + a
    // declared `schema` round-trips through `to_datatype()` into a merged `Datatype`
    // whose viewers TRAVEL (self + inherited) and whose declared schema compiles into an
    // ENFORCED validator that REJECTS a malformed shape and ACCEPTS a valid one — i.e.
    // the contribution path is no longer lossy (this is TEST-7's core mechanism).
    #[test]
    fn contributed_datatype_carries_viewers_and_enforced_schema() {
        use crate::modules::extensions::types::DatatypeContribution;
        // A data-only contribution (as a processor manifest would declare it).
        let yaml = r#"
id: demo/counts
extends: matrix
title: Demo counts
schema:
  type: object
  required: [cells]
  properties:
    cells: { type: integer }
    genes: { type: integer }
storage:
  layout: { kind: chunked_sparse, orientation: csc }
  format: zarr
capabilities: [sliceable]
viewers:
  - { view_kind_id: demo-grid, family: deckgl, consumes: [sliceable] }
input_requirements: { requires: single }
"#;
        let c: DatatypeContribution = serde_norway::from_str(yaml).expect("contribution parses");
        let dt = c.to_datatype();
        // to_datatype() now CARRIES the formerly-dropped fields.
        assert_eq!(dt.viewers.len(), 1, "viewers no longer hardcoded empty");
        assert_eq!(dt.viewers[0].view_kind_id, "demo-grid");
        assert!(
            dt.input_requirements.is_some(),
            "input_requirements travels"
        );

        // Merged alongside the Rust roots, the contributed type participates fully.
        let r = DatatypeRegistry::build_merged(vec![dt]).expect("merged registry valid");
        assert!(r.is_a("demo/counts", "matrix"), "lattice edge resolves");
        // Its OWN viewer + the INHERITED `matrix-grid` both resolve UP the lattice.
        let vk: Vec<String> = r
            .viewers_for("demo/counts")
            .iter()
            .map(|v| v.view_kind_id.clone())
            .collect();
        assert!(
            vk.contains(&"demo-grid".to_string()),
            "self viewer present: {vk:?}"
        );
        assert!(
            vk.contains(&"matrix-grid".to_string()),
            "inherited matrix viewer present: {vk:?}"
        );
        // The declared schema is an ENFORCED validator (NOT the old no-op).
        assert!(
            r.validate_shape(
                "demo/counts",
                &serde_json::json!({"cells": 100, "genes": 2000})
            )
            .is_ok(),
            "a valid shape is accepted"
        );
        assert!(
            r.validate_shape("demo/counts", &serde_json::json!({"cells": "many"}))
                .is_err(),
            "a wrong-typed `cells` is REJECTED"
        );
        assert!(
            r.validate_shape("demo/counts", &serde_json::json!({"genes": 5}))
                .is_err(),
            "a shape missing the required `cells` is REJECTED"
        );
    }

    // ITEM-2 / DEC-6: the hand-rolled JSON-schema SUBSET validator — type/required/
    // properties/items — enforces a declared shape; an empty/null schema is a no-op.
    #[test]
    fn hand_rolled_schema_subset_enforces_and_no_ops() {
        let schema = serde_json::json!({
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": { "type": "string" },
                "tags": { "type": "array", "items": { "type": "string" } }
            }
        });
        // Valid: required present, types match, array items match.
        assert!(validate_against_schema(
            &schema,
            &serde_json::json!({"name":"a","tags":["x","y"]})
        )
        .is_ok());
        // An optional property absent is fine.
        assert!(validate_against_schema(&schema, &serde_json::json!({"name":"a"})).is_ok());
        // Rejections: missing required, wrong scalar type, wrong array-item type.
        assert!(
            validate_against_schema(&schema, &serde_json::json!({})).is_err(),
            "missing required"
        );
        assert!(
            validate_against_schema(&schema, &serde_json::json!({"name": 1})).is_err(),
            "name wrong type"
        );
        assert!(
            validate_against_schema(&schema, &serde_json::json!({"name":"a","tags":[1]})).is_err(),
            "array item wrong type"
        );
        // A `type: integer` schema rejects a non-integer / accepts an integer.
        let int_schema = serde_json::json!({"type":"integer"});
        assert!(validate_against_schema(&int_schema, &serde_json::json!(7)).is_ok());
        assert!(validate_against_schema(&int_schema, &serde_json::json!("7")).is_err());
        // A `minimum` bound (A1) — the non-negative count constraint the former
        // `validate_matrix_shape` enforced: `{ type: integer, minimum: 0 }` REJECTS a
        // negative integer, ACCEPTS zero/positive; a bare `{ type: integer }` accepts
        // the same negative (proving the bound is what restores the old reject).
        let nonneg = serde_json::json!({"type":"integer","minimum":0});
        assert!(validate_against_schema(&nonneg, &serde_json::json!(0)).is_ok());
        assert!(validate_against_schema(&nonneg, &serde_json::json!(5)).is_ok());
        assert!(
            validate_against_schema(&nonneg, &serde_json::json!(-5)).is_err(),
            "minimum rejects negative"
        );
        assert!(
            validate_against_schema(&int_schema, &serde_json::json!(-5)).is_ok(),
            "bare integer accepts negative"
        );
        // The nested-object form the matrix-family schemas use: a negative `cells` is
        // rejected via the property's `minimum`.
        let shape = serde_json::json!({
            "type":"object",
            "properties":{"cells":{"type":"integer","minimum":0},"genes":{"type":"integer","minimum":0}}
        });
        assert!(
            validate_against_schema(&shape, &serde_json::json!({"cells":100,"genes":2000})).is_ok()
        );
        assert!(
            validate_against_schema(&shape, &serde_json::json!({"cells":-1})).is_err(),
            "negative cells rejected"
        );
        // A constraintless schema (empty object / null) accepts anything (no-op).
        assert!(
            validate_against_schema(&serde_json::json!({}), &serde_json::json!({"x":1})).is_ok()
        );
        assert!(validate_against_schema(&serde_json::Value::Null, &serde_json::json!(5)).is_ok());
    }

    // ITEM-3: attach_axes merges axes onto an EXISTING datatype; unknown target +
    // double-declare are errors.
    #[test]
    fn attach_axes_overlays_onto_existing() {
        use crate::modules::datatype::types::AxisSpec;
        let mut r = lattice();
        assert!(r.axes_for("expr").is_empty(), "no axes before overlay");
        r.attach_axes(vec![(
            "expr".into(),
            vec![
                AxisSpec {
                    name: "cell".into(),
                    key_label: "barcode".into(),
                },
                AxisSpec {
                    name: "gene".into(),
                    key_label: "gene_id".into(),
                },
            ],
        )])
        .expect("overlay onto a known type");
        assert_eq!(
            r.axes_for("expr")
                .iter()
                .map(|a| a.name.clone())
                .collect::<Vec<_>>(),
            vec!["cell", "gene"]
        );
        // Unknown target id → error.
        assert!(r.attach_axes(vec![("ghost".into(), vec![])]).is_err());
        // Double-declare → error (no silent overwrite).
        assert!(r
            .attach_axes(vec![(
                "expr".into(),
                vec![AxisSpec {
                    name: "cell".into(),
                    key_label: "barcode".into(),
                }]
            )])
            .is_err());
    }

    // S2 / INV-2: the process-wide holder is HOT-SWAPPABLE. Publishing registry A then
    // re-publishing registry B (a rescan) atomically replaces the snapshot WITHOUT a
    // restart — `registry()` returns B's content after the second `set_global_registry`.
    // This is the mechanism a reload endpoint (S7) / watcher (S6) rests on. No other
    // unit test touches this global, so exercising it here is isolation-safe.
    #[test]
    fn set_global_registry_republishes_without_restart() {
        // Registry A — root + one child.
        let reg_a = Arc::new(
            DatatypeRegistry::from_types(vec![
                mk("root", None, true, &[], &[]),
                mk("alpha", Some("root"), false, &[], &[]),
            ])
            .expect("A builds"),
        );
        set_global_registry(reg_a);
        let loaded_a = registry();
        assert!(loaded_a.get("alpha").is_some());
        assert!(loaded_a.get("beta").is_none());

        // Registry B — root + a DIFFERENT child. A rescan re-publishes it.
        let reg_b = Arc::new(
            DatatypeRegistry::from_types(vec![
                mk("root", None, true, &[], &[]),
                mk("beta", Some("root"), false, &[], &[]),
            ])
            .expect("B builds"),
        );
        set_global_registry(reg_b);

        // A fresh `registry()` load now sees B's content — republish took effect
        // in-process, no restart.
        let loaded_b = registry();
        assert!(
            loaded_b.get("beta").is_some(),
            "republish swapped in the new snapshot"
        );
        assert!(loaded_b.get("alpha").is_none(), "the old snapshot is gone");
        assert!(try_registry().is_some());
    }
}
