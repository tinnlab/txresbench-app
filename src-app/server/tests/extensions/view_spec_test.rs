//! TEST-16 [ITEM-9] — `ViewContribution.view_spec` round-trips through serde.
//!
//! The declarative-view seam (DEC-11) adds an OPTIONAL `view_spec: Option<String>`
//! to `ViewContribution` alongside the baked `entry:`. This asserts the additive
//! field survives a serialize→deserialize round-trip in BOTH states — present (a
//! bundle-relative YAML path) and absent (a code-only view, `None` via
//! `#[serde(default)]`) — the wire contract `GET /api/extensions` dumps and the FE
//! `workbenchRegistry` projects.

use txresbench::modules::extensions::types::ViewContribution;
use serde_json::{json, Value};

// A view carrying a declarative view_spec round-trips it verbatim.
#[test]
fn view_spec_present_round_trips() {
    let view = ViewContribution {
        id: "qc-review".into(),
        title: "QC Review".into(),
        datatype: "single-cell/expression".into(),
        entry: "ui/QcReview.tsx".into(),
        view_spec: Some("ui/qc-review.yaml".into()),
    };

    let wire = serde_json::to_value(&view).expect("serialize");
    // The field serializes under its snake_case wire name.
    assert_eq!(wire["view_spec"], json!("ui/qc-review.yaml"));

    let back: ViewContribution = serde_json::from_value(wire).expect("deserialize");
    assert_eq!(back.view_spec.as_deref(), Some("ui/qc-review.yaml"));
    assert_eq!(back.id, "qc-review");
    assert_eq!(back.entry, "ui/QcReview.tsx");
}

// A view WITHOUT view_spec round-trips to `None`; a manifest that omits it still
// parses (the field is additive, `#[serde(default)]`).
#[test]
fn view_spec_absent_defaults_to_none() {
    // Explicit None serializes to a JSON null and round-trips.
    let view = ViewContribution {
        id: "inspector".into(),
        title: "Inspector".into(),
        datatype: "data/opaque".into(),
        entry: "ui/Inspector.tsx".into(),
        view_spec: None,
    };
    let wire = serde_json::to_value(&view).expect("serialize");
    assert_eq!(wire["view_spec"], Value::Null);
    let back: ViewContribution = serde_json::from_value(wire).expect("deserialize");
    assert_eq!(back.view_spec, None);

    // A manifest object that entirely OMITS `view_spec` still deserializes (default).
    let omitted: ViewContribution = serde_json::from_value(json!({
        "id": "inspector",
        "title": "Inspector",
        "datatype": "data/opaque",
        "entry": "ui/Inspector.tsx"
    }))
    .expect("deserialize without view_spec");
    assert_eq!(omitted.view_spec, None, "omitted view_spec defaults to None");
}
