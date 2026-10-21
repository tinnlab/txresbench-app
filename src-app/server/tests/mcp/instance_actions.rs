//! TEST-6/7/8 (`.lifecycle/ai-actions/TESTS.md`) — the ai-actions slice-3
//! backend deltas over the merged capability catalogs: an INSTANCE-kind
//! frontend action (`harness.setValue`/`harness.describe`, registered by
//! `src/core/actions/builtin/harnessActions.ts`) describes its `view_id`/
//! `expected_token` inputs, its invoke carries both through the REAL agent
//! channel to a SIMULATED engine, a world-model read (`views.list`) returns
//! whatever directory payload the simulated engine answers with (proving the
//! generic frontend-dispatch path, no special backend casing needed for
//! reads), and a simulated-stale mutating invoke relays as an `isError`
//! `STALE_STATE` tool result — the backend never judges staleness itself
//! (ARCHITECTURE.md Layer 5/6: permission = backend-enforced trust,
//! staleness = engine-enforced correctness; this suite only proves the
//! backend RELAYS the engine's verdict faithfully).

use std::time::Duration;

use serde_json::{json, Value};
use uuid::Uuid;

use super::{create_user, login, next_sse_event, open_agent_stream, post_agent_result, setup_admin, tools_call};
use crate::common::TestServer;

// ------------------------------- TEST-6 -------------------------------

#[tokio::test]
async fn describe_capability_reports_instance_action_view_id_and_expected_token_inputs() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "describer", "describer@x.test").await;
    let user = login(&server, "describer").await;

    // A mutating+stateful instance action requires BOTH inputs.
    let set_value = tools_call(
        &server,
        &user,
        "describe_capability",
        json!({ "operation_id": "harness.setValue" }),
    )
    .await;
    let structured = &set_value["structuredContent"];
    assert_eq!(structured["frontend_kind"], "instance", "{structured}");
    assert_eq!(structured["mutating"], true);
    assert_eq!(structured["stateful"], true);
    assert_eq!(structured["view_id_required"], true);
    assert_eq!(structured["expected_token_required"], true);

    // A non-mutating instance READ requires view_id but never expected_token.
    let describe = tools_call(
        &server,
        &user,
        "describe_capability",
        json!({ "operation_id": "harness.describe" }),
    )
    .await;
    let structured = &describe["structuredContent"];
    assert_eq!(structured["frontend_kind"], "instance", "{structured}");
    assert_eq!(structured["mutating"], false);
    assert_eq!(structured["view_id_required"], true);
    assert_eq!(structured["expected_token_required"], false);

    // A GLOBAL action never carries either field.
    let navigate = tools_call(
        &server,
        &user,
        "describe_capability",
        json!({ "operation_id": "app.navigate" }),
    )
    .await;
    let structured = &navigate["structuredContent"];
    assert_eq!(structured["frontend_kind"], "global", "{structured}");
    assert!(structured.get("view_id_required").is_none());
    assert!(structured.get("expected_token_required").is_none());
}

#[tokio::test]
async fn invoke_instance_action_relays_view_id_and_expected_token_over_the_real_agent_channel() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "driver", "driver@x.test").await;
    let driver = login(&server, "driver").await;

    let session_id = Uuid::new_v4();
    let (mut stream, mut buf) = open_agent_stream(&server, &driver, session_id).await;

    let (invoke_result, ()) = tokio::join!(
        tools_call(
            &server,
            &driver,
            "invoke_capability",
            json!({
                "operation_id": "harness.setValue",
                "body": { "view_id": "v1", "value": 5, "expected": "v1@0" }
            }),
        ),
        async {
            let invoke_frame = next_sse_event(&mut stream, &mut buf, Duration::from_secs(10))
                .await
                .expect("agent_invoke frame arrives over the real SSE channel");
            assert_eq!(invoke_frame["type"], "agent_invoke");
            assert_eq!(invoke_frame["action_id"], "harness.setValue");
            // The full params still carry view_id/expected (the manifest's own
            // zod schema requires them) — AND the backend threads them through
            // as dedicated top-level fields for the engine's guard.
            assert_eq!(invoke_frame["params"]["view_id"], "v1");
            assert_eq!(invoke_frame["params"]["value"], 5);
            assert_eq!(invoke_frame["params"]["expected"], "v1@0");
            assert_eq!(invoke_frame["view_id"], "v1", "{invoke_frame}");
            assert_eq!(invoke_frame["expected_token"], "v1@0", "{invoke_frame}");
            let request_id = invoke_frame["request_id"].clone();

            post_agent_result(
                &server,
                &driver,
                request_id,
                true,
                json!({ "value": 5, "_state_token": "v1@1" }),
                None,
            )
            .await;
        }
    );

    assert!(
        invoke_result.get("isError").is_none(),
        "instance invoke succeeded end-to-end: {invoke_result}"
    );
    let structured = &invoke_result["structuredContent"];
    assert_eq!(structured["kind"], "frontend");
    assert_eq!(structured["ok"], true);
    assert_eq!(structured["result"]["value"], 5);
    assert_eq!(structured["result"]["_state_token"], "v1@1");
}

// ------------------------------- TEST-7 -------------------------------

#[tokio::test]
async fn world_model_read_returns_the_simulated_engines_directory_payload_with_state_tokens() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "reader", "reader@x.test").await;
    let reader = login(&server, "reader").await;

    let session_id = Uuid::new_v4();
    let (mut stream, mut buf) = open_agent_stream(&server, &reader, session_id).await;

    let (invoke_result, ()) = tokio::join!(
        tools_call(
            &server,
            &reader,
            "invoke_capability",
            json!({ "operation_id": "views.list", "body": {} }),
        ),
        async {
            let invoke_frame = next_sse_event(&mut stream, &mut buf, Duration::from_secs(10))
                .await
                .expect("agent_invoke frame arrives for the world-model read");
            assert_eq!(invoke_frame["action_id"], "views.list");
            // views.list is a GLOBAL action — no view_id/expected_token, even
            // though a per-instance read (view.describe) DOES address one.
            assert!(invoke_frame.get("view_id").is_none(), "{invoke_frame}");
            let request_id = invoke_frame["request_id"].clone();

            post_agent_result(
                &server,
                &reader,
                request_id,
                true,
                json!({
                    "views": [
                        { "view_id": "v1", "type": "harness", "_state_token": "v1@3" },
                        { "view_id": "v2", "type": "harness", "_state_token": "v2@0" },
                    ]
                }),
                None,
            )
            .await;
        }
    );

    assert!(invoke_result.get("isError").is_none(), "{invoke_result}");
    let views = invoke_result["structuredContent"]["result"]["views"]
        .as_array()
        .expect("views array");
    assert_eq!(views.len(), 2);
    assert_eq!(views[0]["view_id"], "v1");
    assert_eq!(views[0]["_state_token"], "v1@3");
    assert_eq!(views[1]["_state_token"], "v2@0");
}

// ------------------------------- TEST-8 -------------------------------

#[tokio::test]
async fn mutating_instance_invoke_reported_stale_by_the_engine_surfaces_as_iserror_stale_state() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "stale-driver", "stale-driver@x.test").await;
    let driver = login(&server, "stale-driver").await;

    let session_id = Uuid::new_v4();
    let (mut stream, mut buf) = open_agent_stream(&server, &driver, session_id).await;

    let (invoke_result, ()) = tokio::join!(
        tools_call(
            &server,
            &driver,
            "invoke_capability",
            json!({
                "operation_id": "harness.setValue",
                // A caller-presented token the (simulated) engine will judge
                // stale — the backend does NOT reject this itself; it relays
                // whatever the engine decides.
                "body": { "view_id": "v1", "value": 9, "expected": "v1@0" }
            }),
        ),
        async {
            let invoke_frame = next_sse_event(&mut stream, &mut buf, Duration::from_secs(10))
                .await
                .expect("agent_invoke frame arrives");
            assert_eq!(invoke_frame["expected_token"], "v1@0");
            let request_id = invoke_frame["request_id"].clone();

            // The simulated engine plays the real `./engine.ts` stale-guard's
            // rejection shape verbatim (ARCHITECTURE.md Layer 6) — `ok: false`
            // with a `STALE_STATE`-prefixed error, no `result`.
            post_agent_result(
                &server,
                &driver,
                request_id,
                false,
                Value::Null,
                Some("STALE_STATE: view \"v1\" changed (expected v1@0, now v1@2); re-read view.describe('v1') and retry"),
            )
            .await;
        }
    );

    assert_eq!(invoke_result["isError"], true, "{invoke_result}");
    let structured = &invoke_result["structuredContent"];
    assert_eq!(structured["kind"], "frontend");
    assert_eq!(structured["ok"], false);
    assert!(
        structured["error"]
            .as_str()
            .unwrap_or_default()
            .starts_with("STALE_STATE"),
        "{structured}"
    );
}

// ------------------------- audit fix: view_id type/presence -------------------------
//
// `invoke_frontend` (`handlers.rs`) used to extract `view_id` with
// `.as_str()` and silently coerce a missing/non-string value to `None` —
// even though `describe_capability` advertises `view_id_required: true` for
// every `kind == "instance"` action, and `validate_body` only checks
// required-PRESENCE + `additionalProperties`, never JSON-Schema `type`. A
// caller sending `{"view_id": 123}` would previously sail through both
// checks and dispatch with NO instance target at all. These two tests pin
// the fix: a non-string `view_id` is now rejected with `INVALID_VIEW_ID`
// (caught by the new `kind == "instance"` type guard in `invoke_frontend`,
// since `validate_body`'s required-presence check alone lets it through);
// a wholesale-missing `view_id` is rejected up front by `validate_body`
// itself (both `harness.*` actions declare `view_id` in their manifest
// `params_schema.required`) — proving BOTH failure shapes are a clear
// `isError`, never a silent `None` relayed to the agent channel. Neither
// test opens an agent SSE stream: `tools_call` returning synchronously
// (rather than hanging on a `agent_invoke` frame nobody will answer) is
// itself proof that no dispatch was attempted.

#[tokio::test]
async fn invoke_instance_action_with_non_string_view_id_is_rejected_not_silently_coerced_to_none() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "bad-view-id", "bad-view-id@x.test").await;
    let driver = login(&server, "bad-view-id").await;

    let invoke_result = tools_call(
        &server,
        &driver,
        "invoke_capability",
        json!({
            "operation_id": "harness.setValue",
            // view_id present (so validate_body's required-presence check
            // passes) but the WRONG JSON type — this is exactly the gap
            // `validate_body` cannot catch on its own.
            "body": { "view_id": 123, "value": 5, "expected": "v1@0" }
        }),
    )
    .await;

    assert_eq!(invoke_result["isError"], true, "{invoke_result}");
    let structured = &invoke_result["structuredContent"];
    assert_eq!(structured["kind"], "frontend");
    assert_eq!(structured["ok"], false);
    assert_eq!(structured["error_code"], "INVALID_VIEW_ID", "{structured}");
}

#[tokio::test]
async fn invoke_instance_action_with_missing_view_id_is_rejected_not_silently_dispatched() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "no-view-id", "no-view-id@x.test").await;
    let driver = login(&server, "no-view-id").await;

    let invoke_result = tools_call(
        &server,
        &driver,
        "invoke_capability",
        json!({
            "operation_id": "harness.setValue",
            // view_id entirely absent — the manifest's own params_schema
            // already lists it as `required`, so `validate_body` rejects
            // this before `invoke_frontend`'s kind=="instance" branch ever
            // runs; this test proves that layer keeps working (not a
            // silent `None` slipping past both checks).
            "body": { "value": 5, "expected": "v1@0" }
        }),
    )
    .await;

    assert_eq!(invoke_result["isError"], true, "{invoke_result}");
    let structured = &invoke_result["structuredContent"];
    assert_eq!(structured["kind"], "frontend");
    assert_eq!(structured["ok"], false);
    let code = structured["error_code"].as_str().unwrap_or_default();
    assert!(
        code == "MISSING_VIEW_ID" || code == "INVALID_PARAMS",
        "expected a clear view_id-related rejection code, got {structured}"
    );
    let message = invoke_result["content"][0]["text"].as_str().unwrap_or_default();
    assert!(
        message.contains("view_id"),
        "error message should name the missing field: {invoke_result}"
    );
}
