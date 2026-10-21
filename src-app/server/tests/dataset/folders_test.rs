//! TEST-46 [ITEM-24] — dataset folders: CRUD owner-scoped; `dataset_folder_members`
//! M:N (one dataset in two folders); add/remove membership; `SyncEntity::DatasetFolder`
//! emits; a foreign owner's folder 404s.

use std::time::Duration;

use serde_json::{json, Value};

use super::{create_dataset, create_user, login, read_until, setup_admin};
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

async fn folder_dataset_ids(server: &TestServer, token: &str, folder: &str) -> Vec<String> {
    let list: Value = server
        .client
        .get(server.api_url(&format!("/dataset-folders/{folder}/datasets")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    list.as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn folder_crud_membership_and_scope() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "fo", "fo@x.test").await;
    let fo = login(&server, "fo").await;
    create_user(&server, &admin, "other", "other@x.test").await;
    let other = login(&server, "other").await;

    let f1 = create_folder(&server, &fo, "Project A").await;
    let f2 = create_folder(&server, &fo, "Project B").await;
    let ds = create_dataset(&server, &fo, "shared-across-folders").await;

    // List: both folders present.
    let folders: Value = server
        .client
        .get(server.api_url("/dataset-folders"))
        .bearer_auth(&fo)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(folders.as_array().unwrap().len(), 2);

    // M:N — add the SAME dataset to BOTH folders.
    for f in [&f1, &f2] {
        let r = server
            .client
            .post(server.api_url(&format!("/dataset-folders/{f}/datasets/{ds}")))
            .bearer_auth(&fo)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 200, "add to {f}");
    }
    assert!(
        folder_dataset_ids(&server, &fo, &f1).await.contains(&ds),
        "in f1"
    );
    assert!(
        folder_dataset_ids(&server, &fo, &f2).await.contains(&ds),
        "in f2"
    );

    // Remove from f1 → still in f2.
    let rm = server
        .client
        .delete(server.api_url(&format!("/dataset-folders/{f1}/datasets/{ds}")))
        .bearer_auth(&fo)
        .send()
        .await
        .unwrap();
    assert_eq!(
        rm.status().as_u16(),
        204,
        "DELETE folder-member → 204 No Content"
    );
    assert!(
        !folder_dataset_ids(&server, &fo, &f1).await.contains(&ds),
        "removed from f1"
    );
    assert!(
        folder_dataset_ids(&server, &fo, &f2).await.contains(&ds),
        "still in f2"
    );

    // Rename f2.
    let ren = server
        .client
        .put(server.api_url(&format!("/dataset-folders/{f2}")))
        .bearer_auth(&fo)
        .json(&json!({"name":"Project B2"}))
        .send()
        .await
        .unwrap();
    assert_eq!(ren.status().as_u16(), 200);
    assert_eq!(
        ren.json::<Value>().await.unwrap()["name"],
        json!("Project B2")
    );

    // Owner-scope: a foreign user cannot see, rename, or add to fo's folder.
    let foreign_list = server
        .client
        .get(server.api_url(&format!("/dataset-folders/{f2}/datasets")))
        .bearer_auth(&other)
        .send()
        .await
        .unwrap();
    assert_eq!(
        foreign_list.status().as_u16(),
        404,
        "foreign folder list → 404"
    );
    let foreign_rename = server
        .client
        .put(server.api_url(&format!("/dataset-folders/{f2}")))
        .bearer_auth(&other)
        .json(&json!({"name":"hax"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        foreign_rename.status().as_u16(),
        404,
        "foreign rename → 404"
    );
    let foreign_add = server
        .client
        .post(server.api_url(&format!("/dataset-folders/{f2}/datasets/{ds}")))
        .bearer_auth(&other)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_add.status().as_u16(), 404, "foreign add → 404");

    // Delete f2 (DELETE → 204 No Content).
    let del = server
        .client
        .delete(server.api_url(&format!("/dataset-folders/{f2}")))
        .bearer_auth(&fo)
        .send()
        .await
        .unwrap();
    assert_eq!(del.status().as_u16(), 204);
    let after: Value = server
        .client
        .get(server.api_url("/dataset-folders"))
        .bearer_auth(&fo)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after.as_array().unwrap().len(), 1, "one folder left");
}

#[tokio::test]
async fn folder_create_emits_sync() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "sy", "sy@x.test").await;
    let sy = login(&server, "sy").await;

    let mut stream = server
        .client
        .get(server.api_url("/sync/subscribe"))
        .bearer_auth(&sy)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .unwrap();
    assert!(read_until(&mut stream, "connected", Duration::from_secs(5)).await);

    let _f = create_folder(&server, &sy, "synced-folder").await;
    assert!(
        read_until(&mut stream, "\"dataset_folder\"", Duration::from_secs(5)).await,
        "folder create emits a dataset_folder sync frame to the owner"
    );
}
