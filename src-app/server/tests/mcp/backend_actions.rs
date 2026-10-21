//! TEST-7 — the REST/OpenAPI capability catalog: `list_capabilities` surfaces
//! the backend op `Project.list`, and `invoke_capability` of it dispatches over
//! loopback (forwarding the caller's JWT so the real route re-authorizes +
//! scopes as that caller) and relays the real HTTP 200 project list.

use serde_json::json;

use super::{create_user, login, setup_admin, tools_call};
use crate::common::TestServer;

#[tokio::test]
async fn list_capabilities_includes_the_project_list_backend_op() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let result = tools_call(
        &server,
        &admin,
        "list_capabilities",
        json!({ "query": "project.list" }),
    )
    .await;
    let ops = result["structuredContent"]["operations"]
        .as_array()
        .expect("operations array");
    let project_list = ops
        .iter()
        .find(|op| op["operation_id"] == "Project.list")
        .expect("Project.list present in list_capabilities");
    assert_eq!(project_list["kind"], "rest");
    assert_eq!(project_list["method"], "GET");
    assert_eq!(project_list["required_permission"], "projects::use");
}

#[tokio::test]
async fn invoke_capability_project_list_dispatches_over_loopback_with_forwarded_jwt() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;

    // A real project, created via the REAL /projects route (not MCP).
    let create = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(&alice)
        .json(&json!({ "name": "MCP-visible project" }))
        .send()
        .await
        .unwrap();
    assert_eq!(create.status().as_u16(), 201);

    // invoke_capability("Project.list") AS ALICE over the MCP surface — proves
    // the loopback dispatch forwards alice's bearer so the real /projects
    // route re-authorizes + scopes to HER (not the admin's), and relays the
    // real HTTP 200 response body back through the MCP tool result.
    let result = tools_call(
        &server,
        &alice,
        "invoke_capability",
        json!({ "operation_id": "Project.list" }),
    )
    .await;
    assert!(result.get("isError").is_none(), "invoke succeeded: {result}");
    let structured = &result["structuredContent"];
    assert_eq!(structured["operation_id"], "Project.list");
    assert_eq!(structured["kind"], "rest");
    assert_eq!(structured["ok"], true);
    assert_eq!(structured["status"], 200);
    let projects = structured["response"]["projects"]
        .as_array()
        .expect("projects array in the relayed response");
    assert!(
        projects.iter().any(|s| s["name"] == "MCP-visible project"),
        "the loopback-dispatched Project.list relayed alice's real project: {structured}"
    );
}
