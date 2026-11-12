//! **TEST-9 for #182.** Declared-datatype archive typing and by-basename group
//! planning, deliberately UNCHANGED: group planning reads only FILENAMES and sniffing
//! only a bounded head, so it must behave identically now that the parts are staged
//! temp files rather than `Vec<u8>`.
//! TEST-74 [ITEM-28] — mtx-trio manifest datatype + filename auto-group.
//!
//! Uploading the canonical 10x Genomics raw matrix trio (`matrix.mtx.gz` +
//! `barcodes.tsv.gz` + `features.tsv.gz`) WITHOUT an explicit `groups` spec
//! auto-groups the three files into ONE `single-cell/matrix-mtx` (Manifest)
//! dataset with 3 `dataset_files` — one logical thing. A lone `.mtx` + an
//! unrelated file stay SEPARATE (DEC-2 confirm-not-guess), and `split` still
//! breaks the auto-grouped trio back into per-file datasets. Full production path
//! (real spawned server + Postgres + txresbench-file store), mirroring `upload_test.rs`.

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};

use super::{create_user, login, setup_admin};
use crate::common::TestServer;

fn part(name: &str, bytes: &[u8]) -> Part {
    Part::bytes(bytes.to_vec()).file_name(name.to_string())
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
async fn declared_datatype_types_a_single_trio_archive() {
    // A 10x trio delivered as ONE bundled archive (`.tar.gz`) is a single file that
    // sniffs to nothing and is not a canonical trio name — so WITHOUT a declared
    // type it would land untyped and never convert. The type-first wizard sends
    // `datatype=single-cell/matrix-mtx`; the upload path must honor it, typing the
    // archive as the (Manifest) mtx-trio so the converter (which extracts the
    // archive in-sandbox) expands it. Passing cardinality: a Manifest with 1 file
    // (the bundle) is allowed.
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let form = Form::new()
        // gzip magic 0x1f8b — a stand-in .tar.gz bundle (the converter extracts it
        // in-sandbox; here we only assert the upload-path TYPING).
        .part(
            "file",
            part("pbmc_10x.tar.gz", b"\x1f\x8b\x08 fake tar.gz trio bundle"),
        )
        .text("datatype", "single-cell/matrix-mtx");
    let (status, body) = upload(&server, &admin, form).await;
    assert_eq!(status, 200, "declared-type archive upload succeeds: {body}");

    let datasets = body["datasets"].as_array().unwrap();
    assert_eq!(datasets.len(), 1, "the single archive is one dataset");
    assert_eq!(
        datasets[0]["datatype"],
        json!("single-cell/matrix-mtx"),
        "typed by the DECLARED datatype (a raw .tar.gz sniffs to nothing)"
    );
    assert_eq!(
        datasets[0]["files"].as_array().unwrap().len(),
        1,
        "the bundle is stored as one file (the converter expands it in-sandbox)"
    );
}

#[tokio::test]
async fn upload_rejects_unknown_declared_datatype() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let form = Form::new()
        .part("file", part("x.bin", b"whatever"))
        .text("datatype", "not/a-real-datatype");
    let (status, _body) = upload(&server, &admin, form).await;
    assert_eq!(
        status, 400,
        "an unknown declared datatype is rejected up front"
    );
}

#[tokio::test]
async fn mtx_trio_autogroups_into_one_manifest_dataset() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "mtx", "mtx@x.test").await;
    let mtx = login(&server, "mtx").await;

    // The canonical 10x raw trio, uploaded together with NO explicit `groups`.
    let form = Form::new()
        .part(
            "file",
            part("matrix.mtx.gz", b"\x1f\x8b\x08 fake matrix payload"),
        )
        .part(
            "file",
            part("barcodes.tsv.gz", b"\x1f\x8b\x08 fake barcodes payload"),
        )
        .part(
            "file",
            part("features.tsv.gz", b"\x1f\x8b\x08 fake features payload"),
        );
    let (status, body) = upload(&server, &mtx, form).await;
    assert_eq!(status, 200, "trio upload succeeds: {body}");

    let datasets = body["datasets"].as_array().unwrap();
    assert_eq!(
        datasets.len(),
        1,
        "the trio auto-groups into ONE dataset (not three)"
    );
    let ds = &datasets[0];
    assert_eq!(
        ds["datatype"],
        json!("single-cell/matrix-mtx"),
        "typed as the mtx-trio Manifest datatype"
    );
    assert_eq!(
        ds["files"].as_array().unwrap().len(),
        3,
        "one dataset holds all three trio files (3 dataset_files)"
    );
    let hash = ds["content_hash"].as_str().expect("content_hash set");
    assert!(
        hash.starts_with("sha256:"),
        "multi-file merkle content_hash: {hash}"
    );

    // The library holds exactly ONE dataset (the grouped trio), not three.
    let mine: Value = server
        .client
        .get(server.api_url("/datasets"))
        .bearer_auth(&mtx)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        mine["items"].as_array().unwrap().len(),
        1,
        "library has just the one grouped dataset"
    );
}

#[tokio::test]
async fn lone_mtx_and_unrelated_stay_separate() {
    // DEC-2 confirm-not-guess: without a complete trio, files stay one-per-file.
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "lone", "lone@x.test").await;
    let lone = login(&server, "lone").await;

    // A lone `matrix.mtx` (no barcodes/features) + an unrelated report → NOT a trio.
    let form = Form::new()
        .part(
            "file",
            part(
                "matrix.mtx",
                b"%%MatrixMarket matrix coordinate integer general\n1 1 1\n1 1 1\n",
            ),
        )
        .part("file", part("notes.html", b"<html>unrelated report</html>"));
    let (status, body) = upload(&server, &lone, form).await;
    assert_eq!(status, 200, "upload succeeds: {body}");

    let datasets = body["datasets"].as_array().unwrap();
    assert_eq!(
        datasets.len(),
        2,
        "no complete trio → two independent single-file datasets"
    );
    for d in datasets {
        assert_eq!(
            d["files"].as_array().unwrap().len(),
            1,
            "each stays single-file"
        );
        assert_ne!(
            d["datatype"],
            json!("single-cell/matrix-mtx"),
            "neither independent file is the auto-group type"
        );
    }
}

#[tokio::test]
async fn split_still_separates_an_autogrouped_trio() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "spl", "spl@x.test").await;
    let spl = login(&server, "spl").await;

    // Auto-group a trio (no explicit `groups`).
    let form = Form::new()
        .part("file", part("matrix.mtx.gz", b"\x1f\x8b\x08 m"))
        .part("file", part("barcodes.tsv.gz", b"\x1f\x8b\x08 b"))
        .part("file", part("features.tsv.gz", b"\x1f\x8b\x08 f"));
    let (status, body) = upload(&server, &spl, form).await;
    assert_eq!(status, 200);
    let datasets = body["datasets"].as_array().unwrap();
    assert_eq!(datasets.len(), 1, "trio auto-grouped into one dataset");
    let parent_id = datasets[0]["id"].as_str().unwrap().to_string();
    assert_eq!(datasets[0]["files"].as_array().unwrap().len(), 3);

    // Split → three single-file datasets; the parent is gone.
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{parent_id}/split")))
        .bearer_auth(&spl)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "split the auto-grouped trio");
    let out: Value = resp.json().await.unwrap();
    let children = out["datasets"].as_array().unwrap();
    assert_eq!(children.len(), 3, "one dataset per trio file");
    for c in children {
        assert_eq!(
            c["files"].as_array().unwrap().len(),
            1,
            "each child is single-file"
        );
    }

    // The parent is gone; the library now holds exactly the three children.
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
        3,
        "library has the three split children"
    );
}
