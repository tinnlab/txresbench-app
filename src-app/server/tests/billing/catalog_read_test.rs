//! #41 (admin-settings-coverage) — TEST-1: the READ-ONLY plan catalog view.
//!
//! TEST-1 [acceptance][invariant: INV-1][covers ITEM-5]: `GET /api/billing/catalog` returns
//! the code-defined plans with allowances + policy and NO Stripe price ids; AND the COGS
//! boundary stays code-defined — there is no route that MUTATES a catalog allowance (a PUT to
//! `/billing/catalog` is not allowed) and the settings PUT body carries no allowance field.

use serde_json::json;

use crate::account::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn catalog_is_read_only_and_omits_price_ids() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // The catalog reads the code-defined free + pro plans with their allowances/policy.
    let resp = server
        .client
        .get(server.api_url("/billing/catalog"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET catalog");
    assert_eq!(resp.status().as_u16(), 200);
    let plans: serde_json::Value = resp.json().await.unwrap();
    let arr = plans.as_array().expect("catalog is an array");
    assert!(arr.len() >= 2, "at least free + pro");

    let free = arr.iter().find(|p| p["id"] == "free").expect("free plan");
    assert_eq!(free["compute_allowance"], 3600);
    assert_eq!(free["storage_allowance"], 5);
    assert_eq!(free["hard_cap"], true);
    assert_eq!(free["overage"], false);

    let pro = arr.iter().find(|p| p["id"] == "pro").expect("pro plan");
    assert_eq!(pro["compute_allowance"], 360000);
    assert_eq!(pro["storage_allowance"], 100);
    assert_eq!(pro["overage"], true);
    assert_eq!(pro["hard_cap"], false);

    // NO Stripe price ids are exposed (env-sourced deployment config, DEC-6).
    for p in arr {
        let obj = p.as_object().unwrap();
        assert!(
            !obj.keys().any(|k| k.contains("price") || k.contains("stripe")),
            "catalog entry must not expose price/stripe ids: {obj:?}"
        );
    }

    // INV-1: the catalog is NOT mutable — there is no PUT route (a PUT is refused, not accepted).
    let put = server
        .client
        .put(server.api_url("/billing/catalog"))
        .bearer_auth(&token)
        .json(&json!({ "id": "free", "compute_allowance": 999999 }))
        .send()
        .await
        .expect("PUT catalog");
    assert!(
        matches!(put.status().as_u16(), 404 | 405),
        "no catalog mutation route (PUT → 404/405), got {}",
        put.status().as_u16()
    );

    // The catalog view is unchanged after that attempt (code-defined, not operator-writable).
    let after: serde_json::Value = server
        .client
        .get(server.api_url("/billing/catalog"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET catalog again")
        .json()
        .await
        .unwrap();
    let free_after = after.as_array().unwrap().iter().find(|p| p["id"] == "free").unwrap();
    assert_eq!(free_after["compute_allowance"], 3600, "catalog allowance unchanged");
}
