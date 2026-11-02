//! **TEST-8 for #182.** The existing upload suite, deliberately UNCHANGED: it is
//! what proves the streaming rewrite kept the shipped behaviour (>2 MB single-file
//! sniff+hash, default-splits/explicit-joins grouping, cardinality). Its
//! `large_single_file_upload_sniffs_and_hashes` leg is also the end-to-end evidence
//! that the upload routes carry a body limit ABOVE axum's 2 MB default.
//! TEST-5 [ITEM-4] — streaming upload → dataset(s): a >2 MB multipart upload
//! succeeds (the raised body limit); sniff sets the datatype; an explicit group
//! (a multi-file-layout set) → ONE dataset; independent single-file datatypes →
//! separate datasets; `split` breaks a multi-file dataset apart.
//!
//! NOTE: the datatype registry types a lone `.mtx` as a Single-layout
//! `single-cell/expression` (a proper multi-file 10x-manifest datatype is ITEM-8),
//! so the multi-file grouping is exercised via `.h5ad` (a Manifest-layout
//! datatype) — the grouping + cardinality logic is identical.

use reqwest::multipart::{Form, Part};
use serde_json::Value;

use super::{create_user, login, setup_admin};
use crate::common::TestServer;

fn h5ad_part(name: &str) -> Part {
    // A zip-container-ish blob under a `.h5ad` name → sniffs to single-cell/anndata.
    Part::bytes(b"PK\x03\x04 fake anndata payload".to_vec()).file_name(name.to_string())
}

async fn upload(server: &TestServer, token: &str, form: Form) -> (u16, Value) {
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .unwrap();
    let status = resp.status().as_u16();
    let body = resp.json::<Value>().await.unwrap_or(Value::Null);
    (status, body)
}

#[tokio::test]
async fn large_single_file_upload_sniffs_and_hashes() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "upl", "up@x.test").await;
    let up = login(&server, "upl").await;

    // A >2 MB file — proves the raised body limit (axum default is 2 MB).
    let mut big = String::from("cell,gene_a,gene_b\n");
    while big.len() < 3 * 1024 * 1024 {
        big.push_str("c,1,2\n");
    }
    let form = Form::new().part(
        "file",
        Part::bytes(big.into_bytes()).file_name("matrix.h5mu"),
    );
    let (status, body) = upload(&server, &up, form).await;
    assert_eq!(status, 200, "a >2 MB upload succeeds (body limit raised)");

    let datasets = body["datasets"].as_array().unwrap();
    assert_eq!(datasets.len(), 1, "one file → one dataset");
    let ds = &datasets[0];
    assert_eq!(
        ds["datatype"],
        serde_json::json!("single-cell/multimodal"),
        "sniff set the datatype (.h5mu → single-cell/multimodal)"
    );
    assert_eq!(ds["files"].as_array().unwrap().len(), 1);
    let hash = ds["content_hash"].as_str().expect("content_hash set");
    assert!(
        hash.starts_with("sha256:"),
        "single-file content_hash is sha256:<hex>: {hash}"
    );
}

#[tokio::test]
async fn grouping_default_splits_explicit_joins() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "grp", "grp@x.test").await;
    let grp = login(&server, "grp").await;

    // Default (no `groups`): two independent .h5ad → TWO datasets.
    let form = Form::new()
        .part("file", h5ad_part("a.h5ad"))
        .part("file", h5ad_part("b.h5ad"));
    let (status, body) = upload(&server, &grp, form).await;
    assert_eq!(status, 200);
    assert_eq!(
        body["datasets"].as_array().unwrap().len(),
        2,
        "two independent files → two datasets"
    );

    // Explicit group: three files jointly form ONE dataset.
    let form = Form::new()
        .part("file", h5ad_part("matrix.h5ad"))
        .part("file", h5ad_part("barcodes.h5ad"))
        .part("file", h5ad_part("features.h5ad"))
        .text("groups", "[[0,1,2]]");
    let (status, body) = upload(&server, &grp, form).await;
    assert_eq!(status, 200);
    let datasets = body["datasets"].as_array().unwrap();
    assert_eq!(datasets.len(), 1, "an explicit group → one dataset");
    assert_eq!(
        datasets[0]["files"].as_array().unwrap().len(),
        3,
        "the dataset holds all three files"
    );
    let hash = datasets[0]["content_hash"]
        .as_str()
        .expect("multi-file content_hash");
    assert!(
        hash.starts_with("sha256:"),
        "multi-file merkle content_hash"
    );
}

#[tokio::test]
async fn single_layout_group_is_rejected() {
    // DEC-2: a Single-layout datatype cannot hold >1 file (grouping two files of
    // such a type into one dataset is a cardinality error).
    //
    // Uses `.html` (→ `report/html`, `FileLayout::Single` — `datatype/builtin.rs`).
    // This previously used two `.csv`, whose Single-layout `de` datatype was pruned
    // by `9ee2112b` ("it was also the sole csv/tsv ingest type → those uploads now
    // sniff to `unknown`"). That commit repointed the other `de`/csv assertions but
    // missed this one, so a `.csv` pair stopped being a cardinality error and the
    // upload correctly returned 200.
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "card", "card@x.test").await;
    let card = login(&server, "card").await;

    let form = Form::new()
        .part(
            "file",
            Part::bytes(b"<html><body>one</body></html>".to_vec()).file_name("one.html"),
        )
        .part(
            "file",
            Part::bytes(b"<html><body>two</body></html>".to_vec()).file_name("two.html"),
        )
        .text("groups", "[[0,1]]");
    let (status, _body) = upload(&server, &card, form).await;
    assert_eq!(
        status, 400,
        "grouping two Single-layout files → 400 cardinality"
    );
}

#[tokio::test]
async fn split_separates_a_multifile_dataset() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "spl", "spl@x.test").await;
    let spl = login(&server, "spl").await;

    // Upload a grouped 2-file dataset.
    let form = Form::new()
        .part("file", h5ad_part("x.h5ad"))
        .part("file", h5ad_part("y.h5ad"))
        .text("groups", "[[0,1]]");
    let (status, body) = upload(&server, &spl, form).await;
    assert_eq!(status, 200);
    let parent_id = body["datasets"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(body["datasets"][0]["files"].as_array().unwrap().len(), 2);

    // Split → two single-file datasets; the parent is gone.
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{parent_id}/split")))
        .bearer_auth(&spl)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "split multi-file dataset");
    let out: Value = resp.json().await.unwrap();
    let children = out["datasets"].as_array().unwrap();
    assert_eq!(children.len(), 2, "one dataset per file");
    for c in children {
        assert_eq!(
            c["files"].as_array().unwrap().len(),
            1,
            "each child is single-file"
        );
    }

    // The parent is gone from the library.
    let parent_get = server
        .client
        .get(server.api_url(&format!("/datasets/{parent_id}")))
        .bearer_auth(&spl)
        .send()
        .await
        .unwrap();
    assert_eq!(
        parent_get.status().as_u16(),
        404,
        "parent removed after split"
    );

    // The library now holds exactly the two children.
    let mine: Value = server
        .client
        .get(server.api_url("/datasets"))
        .bearer_auth(&spl)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        mine["items"].as_array().unwrap().len(),
        2,
        "library has the two split children"
    );
    assert_eq!(
        mine["total"].as_i64(),
        Some(2),
        "total reflects the two split children"
    );
}
