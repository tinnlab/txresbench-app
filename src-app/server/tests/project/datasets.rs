//! TEST-20 — project↔dataset grouping (M:N post ITEM-3): attach/list, a dataset in
//! TWO projects at once, detach, the 100-cap → 422, and foreign-project attach → 404.

use serde_json::{json, Value};

use super::{create_dataset, create_project, create_user, login, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn attach_to_two_detach_and_cap() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "ada", "ada@x.test").await;
    let ada = login(&server, "ada").await;

    let a = create_project(&server, &ada, "Project A").await;
    let b = create_project(&server, &ada, "Project B").await;
    let (sa, sb) = (a["id"].as_str().unwrap(), b["id"].as_str().unwrap());
    let ds = create_dataset(&server, &ada, "sample-1").await;

    // Attach ds → project A.
    let att = server.client.post(server.api_url(&format!("/projects/{sa}/datasets/{ds}"))).bearer_auth(&ada).send().await.unwrap();
    assert_eq!(att.status().as_u16(), 200);
    assert_eq!(att.json::<Value>().await.unwrap()["dataset_count"], json!(1));

    // Appears in A's dataset list.
    let list: Value = server.client.get(server.api_url(&format!("/projects/{sa}/datasets"))).bearer_auth(&ada).send().await.unwrap().json().await.unwrap();
    assert_eq!(list["total"], json!(1));
    assert_eq!(list["datasets"][0]["id"], json!(ds));

    // Also attach to B (M:N — the dataset now belongs to BOTH projects, no move).
    let mv = server.client.post(server.api_url(&format!("/projects/{sb}/datasets/{ds}"))).bearer_auth(&ada).send().await.unwrap();
    assert_eq!(mv.status().as_u16(), 200);
    let a_list: Value = server.client.get(server.api_url(&format!("/projects/{sa}/datasets"))).bearer_auth(&ada).send().await.unwrap().json().await.unwrap();
    assert_eq!(a_list["total"], json!(1), "still in A (M:N, not a move)");
    let b_list: Value = server.client.get(server.api_url(&format!("/projects/{sb}/datasets"))).bearer_auth(&ada).send().await.unwrap().json().await.unwrap();
    assert_eq!(b_list["total"], json!(1), "also in B");

    // Detach from B → still in A.
    let de = server.client.delete(server.api_url(&format!("/projects/{sb}/datasets/{ds}"))).bearer_auth(&ada).send().await.unwrap();
    assert_eq!(de.status().as_u16(), 200);
    let b_list2: Value = server.client.get(server.api_url(&format!("/projects/{sb}/datasets"))).bearer_auth(&ada).send().await.unwrap().json().await.unwrap();
    assert_eq!(b_list2["total"], json!(0));
    let a_list2: Value = server.client.get(server.api_url(&format!("/projects/{sa}/datasets"))).bearer_auth(&ada).send().await.unwrap().json().await.unwrap();
    assert_eq!(a_list2["total"], json!(1), "detach from B left A intact");

    // Attaching to a foreign project → 404.
    create_user(&server, &admin, "eve", "eve@x.test").await;
    let eve = login(&server, "eve").await;
    let foreign = server.client.post(server.api_url(&format!("/projects/{sa}/datasets/{ds}"))).bearer_auth(&eve).send().await.unwrap();
    assert_eq!(foreign.status().as_u16(), 404, "attach to a project you can't see → 404");
}

#[tokio::test]
async fn dataset_cap_returns_422() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "cap", "cap@x.test").await;
    let cap = login(&server, "cap").await;
    let project = create_project(&server, &cap, "Capped").await;
    let sid = project["id"].as_str().unwrap();

    // Fill to the 100 cap.
    for i in 0..100 {
        let ds = create_dataset(&server, &cap, &format!("d{i}")).await;
        let r = server.client.post(server.api_url(&format!("/projects/{sid}/datasets/{ds}"))).bearer_auth(&cap).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 200, "attach {i}");
    }
    // The 101st NEW dataset → 422.
    let overflow = create_dataset(&server, &cap, "overflow").await;
    let r = server.client.post(server.api_url(&format!("/projects/{sid}/datasets/{overflow}"))).bearer_auth(&cap).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 422, "the 101st dataset hits the cap → 422");
}
