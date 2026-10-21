//! TEST — server-side SEARCH + total-count + folder filter on the dataset list
//! endpoints. `GET /datasets?search=&folder_id=` and `GET /datasets/shared?search=`
//! return `{ items, total }`; `search` is a case-insensitive name substring;
//! `folder_id` restricts list_mine to a folder's members; `total` reflects the
//! SAME filters (not the whole library).

use serde_json::{json, Value};

use super::{create_dataset, create_user, login, setup_admin};
use crate::common::TestServer;

async fn create_folder(server: &TestServer, token: &str, name: &str) -> String {
    let r = server
        .client
        .post(server.api_url("/dataset-folders"))
        .bearer_auth(token)
        .json(&json!({ "name": name }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 201, "create folder {name}");
    r.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn list_mine(server: &TestServer, token: &str, query: &str) -> Value {
    server
        .client
        .get(server.api_url(&format!("/datasets{query}")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn ids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn list_mine_search_and_folder_filter_with_total() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "lister", "lister@x.test").await;
    let user = login(&server, "lister").await;

    // Three owned datasets with distinct names.
    let alpha = create_dataset(&server, &user, "PBMC Alpha").await;
    let beta = create_dataset(&server, &user, "PBMC Beta").await;
    let gamma = create_dataset(&server, &user, "Liver Gamma").await;

    // Unfiltered: all three, total 3.
    let all = list_mine(&server, &user, "").await;
    assert_eq!(all["items"].as_array().unwrap().len(), 3);
    assert_eq!(all["total"].as_i64(), Some(3), "total = whole library");

    // Case-insensitive substring on the NAME: "pbmc" matches Alpha + Beta only.
    let pbmc = list_mine(&server, &user, "?search=pbmc").await;
    let pbmc_ids = ids(&pbmc);
    assert_eq!(pbmc_ids.len(), 2, "two PBMC datasets match");
    assert!(pbmc_ids.contains(&alpha) && pbmc_ids.contains(&beta));
    assert!(!pbmc_ids.contains(&gamma), "Liver Gamma excluded");
    assert_eq!(
        pbmc["total"].as_i64(),
        Some(2),
        "total reflects the filtered count"
    );

    // A more specific substring narrows further; total tracks it.
    let alpha_only = list_mine(&server, &user, "?search=alpha").await;
    assert_eq!(ids(&alpha_only), vec![alpha.clone()]);
    assert_eq!(alpha_only["total"].as_i64(), Some(1));

    // Blank / whitespace-only search applies NO filter.
    let blank = list_mine(&server, &user, "?search=%20%20").await;
    assert_eq!(
        blank["total"].as_i64(),
        Some(3),
        "whitespace search = no filter"
    );

    // No match → empty items, total 0.
    let none = list_mine(&server, &user, "?search=nonesuch").await;
    assert!(none["items"].as_array().unwrap().is_empty());
    assert_eq!(none["total"].as_i64(), Some(0));

    // folder_id restricts to that folder's members. Put Alpha + Gamma in a folder.
    let folder = create_folder(&server, &user, "My Folder").await;
    for ds in [&alpha, &gamma] {
        let r = server
            .client
            .post(server.api_url(&format!("/dataset-folders/{folder}/datasets/{ds}")))
            .bearer_auth(&user)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 200, "add {ds} to folder");
    }
    let in_folder = list_mine(&server, &user, &format!("?folder_id={folder}")).await;
    let folder_ids = ids(&in_folder);
    assert_eq!(folder_ids.len(), 2, "two datasets in the folder");
    assert!(folder_ids.contains(&alpha) && folder_ids.contains(&gamma));
    assert!(!folder_ids.contains(&beta), "Beta not in the folder");
    assert_eq!(
        in_folder["total"].as_i64(),
        Some(2),
        "total = folder membership count"
    );

    // folder_id + search compose: within the folder, only PBMC → Alpha.
    let folder_pbmc = list_mine(&server, &user, &format!("?folder_id={folder}&search=pbmc")).await;
    assert_eq!(ids(&folder_pbmc), vec![alpha.clone()]);
    assert_eq!(folder_pbmc["total"].as_i64(), Some(1), "combined filters");

    // A foreign (non-owned) folder id yields nothing (owner-scoped join), total 0.
    let foreign = uuid::Uuid::new_v4();
    let foreign_page = list_mine(&server, &user, &format!("?folder_id={foreign}")).await;
    assert!(foreign_page["items"].as_array().unwrap().is_empty());
    assert_eq!(foreign_page["total"].as_i64(), Some(0));
}
