//! Sync wire types + the `publish` seam for TxResBench realtime cross-device
//! sync.
//!
//! Events are **notify-and-refetch**: the wire payload is only
//! `{entity, action, id}` — never row data. The client refetches the changed
//! entity via its existing permission-checked REST endpoint, so the SSE channel
//! never carries anything sensitive. The genuinely app-agnostic half of realtime
//! sync (the per-user connection registry, audience routing, self-echo
//! suppression, the mountable `/sync/subscribe` handler) lives in the SDK
//! (`txresbench_framework::sync`); this module supplies the concrete, schema-bearing
//! wire vocabulary + the process-wide registry singleton (see `surface.rs`).

use axum::response::sse::Event;
use schemars::JsonSchema;
use serde::Serialize;
use uuid::Uuid;

use txresbench_framework::sync::Audience;

/// The kind of entity that changed. Serialized snake_case to match the
/// frontend's `sync:<entity>` event vocabulary. ADD a variant when wiring a new
/// domain; each emitting handler picks the `Audience` explicitly at the
/// `publish` call site (there is no central audience table — an owner-scoped
/// entity broadcast to everyone would be a leak).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SyncEntity {
    // --- Owner-scoped (delivered only to the owning user) ---
    /// A project owned by (or accepted-shared to) the user.
    Project,
    /// A project-share row changed (created/accepted/declined/revoked). Delivered
    /// owner-scoped to the party who must refetch (recipient or owner).
    ProjectShare,
    /// A project-transfer row changed (created/accepted/declined). Owner-scoped.
    ProjectTransfer,
    /// A durable notification for the user (created/read/deleted). Owner-scoped.
    Notification,
    /// A dataset changed (metadata / files / sharing / project membership).
    /// Owner-scoped: emitted to the owner ∪ sharees audience (ITEM-1/2).
    Dataset,
    /// A dataset folder changed (created/renamed/deleted, or a dataset added/
    /// removed). Owner-scoped (ITEM-24). The FE `sync:dataset_folder`
    /// subscription refetches the folder rail.
    DatasetFolder,
    /// The caller's own profile (display fields / active state). Owner-scoped.
    Profile,
    /// A job the user owns (queued/running/stopped/… list-status changes).
    /// Owner-scoped. (Jobs module; the jobs backend emits it once sync-wired
    /// post-merge — until then the FE `sync:job` subscription is a no-op.)
    Job,
    /// A workstore catalog artifact changed (produced by ingest / removed on
    /// delete). Project-scoped: emitted to the project audience (owner ∪ accepted
    /// shares) via the workstore write path, so a shared workbench refetches the
    /// catalog live when a collaborator (or the AI) produces a result. P1 OWNS
    /// this variant; P10 emits `::Artifact` too (there is NO separate
    /// `AnalysisResult` variant — A5). Notify-and-refetch only.
    Artifact,
    /// A provenance RUN NODE changed (recorded on capture). Project-scoped: fanned
    /// to the project's owner ∪ accepted recipients (P4). The FE subscribes to
    /// `sync:provenance` and refetches the runs list / graph.
    ///
    /// **`id` is the RUN id — always.** Building an export used to publish this same
    /// entity carrying a PROJECT id, which made a received `{entity: provenance,
    /// id: X}` undecidable: `X` could name a run or a project, and the wire contract
    /// carries nothing else to disambiguate it. That site is deleted (see
    /// `provenance/handlers.rs::export`), so the entity has exactly one id meaning.
    /// A future project-wide provenance event gets its OWN variant rather than a
    /// second meaning here. Notify-and-refetch only.
    Provenance,
    /// A re-run verification changed (a detached verify task reached a terminal
    /// state). Owner-scoped (P4). `id` is the verification id; the client
    /// refetches `/provenance/verifications`. Notify-and-refetch only.
    ProvenanceVerification,
    /// An account the user is a member of changed (created/renamed/deleted).
    /// Owner-scoped. **Vocabulary only in A1** — the `account` module emits it
    /// once sync-wired by A4 (`publish_account` + the `Accounts` store); until
    /// then the FE `sync:account` subscription is a no-op. `id` is the account id.
    Account,
    /// An account-membership row changed (a member added/removed, or a role
    /// change). Owner-scoped. **Vocabulary only in A1** — emitted once sync-wired
    /// by A4; the FE `sync:account_member` subscription refetches the member list.
    /// `id` is the account id (the changed membership's account).
    AccountMember,
    /// A draftable entity (`drafts` row) changed (created/edited/frozen/deleted).
    /// Project-scoped: emitted to the project audience (owner ∪ accepted shares) via
    /// the drafts write path, so a shared workbench refetches live. The FE subscribes
    /// to `sync:draft` and refetches via the `drafts::use`-gated `GET /api/drafts`.
    /// Notify-and-refetch only.
    Draft,

    // --- Admin-permission-scoped (delivered to holders of the read perm) ---
    /// Deployment-wide project settings (singleton `project_settings`). Delivered to
    /// holders of `projects::use` (every projects user reads the transfer_enabled
    /// flag to gate the Transfer affordance); notify-only — the client refetches.
    ProjectSettings,
    /// Deployment-wide JWT session settings (singleton). Present so the existing
    /// auth `SessionSettings` store's `sync:session_settings` subscription has a
    /// valid entity; the turnkey auth module will emit it once sync-wired.
    SessionSettings,
    /// Deployment-wide job settings (singleton `job_settings`, concurrency cap).
    /// Admin-permission-scoped (jobs module).
    JobSettings,
    /// A user account (admin users list).
    User,
    /// A user group (admin groups list; includes group permissions).
    Group,
    /// An auth provider (local / LDAP / OAuth2 row) was created, edited or
    /// deleted. Delivered to holders of `auth::providers::read` — published by
    /// `txresbench-auth`'s admin provider routes through `AuthSyncEntity::AuthProvider`.
    /// See the `auth_provider` ALLOW_LIST entry in `syncChannelParity.test.ts`:
    /// this app mounts the admin provider ENDPOINTS but has no admin provider
    /// UI, so the client half does not exist yet.
    AuthProvider,
    /// Deployment-wide provenance settings (singleton `provenance_settings`).
    /// Delivered to holders of `provenance::settings::read` (admins via `*`); the
    /// FE settings store refetches on the signal.
    ProvenanceSettings,

    // --- Owner-scoped signal ---
    /// The user's session/permissions changed (group membership or a group's
    /// permissions were edited) — the client re-bootstraps `/auth/me`. `id` is
    /// the affected user id.
    Session,
}

/// What happened to the entity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SyncAction {
    Create,
    Update,
    Delete,
}

/// The change notification pushed to clients. Notify-and-refetch only.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SyncEvent {
    pub entity: SyncEntity,
    pub action: SyncAction,
    pub id: Uuid,
}

/// Handshake payload: the server-assigned connection id. The client echoes it
/// back via the `X-Sync-Connection-Id` header on mutations so the fan-out can
/// skip the originating connection (self-echo suppression).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SyncConnectedData {
    pub connection_id: Uuid,
}

/// The SSE wire enum — the OpenAPI 200-response schema carrier for the subscribe
/// stream (`SyncSurface::Wire`). It exists so `SyncEntity`/`SyncAction`/
/// `SyncEvent`/`SyncConnectedData` enter the generated `types.ts`; the actual
/// stream frames are built by [`sync_event`] / [`connected_event`] below
/// (named `event:` + JSON `data:`), matching the SDK `SyncClient`'s wire contract.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
// Only a schema carrier for the subscribe 200 response — the live frames are
// built by `sync_event`/`connected_event`, so the variants are never constructed.
#[allow(dead_code)]
pub enum SyncSseEvent {
    Connected(SyncConnectedData),
    Sync(SyncEvent),
}

/// Build the `connected` handshake SSE event carrying the connection id.
pub fn connected_event(conn_id: Uuid) -> Event {
    Event::default().event("connected").data(
        serde_json::to_string(&SyncConnectedData {
            connection_id: conn_id,
        })
        .unwrap_or_default(),
    )
}

/// Build a `sync` change-notification SSE event (`{entity,action,id}`).
fn sync_event(entity: SyncEntity, action: SyncAction, id: Uuid) -> Event {
    Event::default()
        .event("sync")
        .data(serde_json::to_string(&SyncEvent { entity, action, id }).unwrap_or_default())
}

/// Publish a change notification to the audience the caller chose.
///
/// The publishing module decides the `audience` (owner / permission rule /
/// everyone) — this core has no per-entity policy. `origin` is the originating
/// SSE connection, skipped to suppress self-echo.
pub fn publish(
    entity: SyncEntity,
    action: SyncAction,
    id: Uuid,
    audience: Audience,
    origin: Option<Uuid>,
) {
    super::surface::registry().deliver(audience, sync_event(entity, action, id), origin);
}

/// WHO performed a mutation, and from which SSE connection.
///
/// This type exists because "whose data changed" and "who changed it" are both a
/// `Uuid`, so at a fan-out call site they are interchangeable by type and the wrong
/// one compiles silently. That is not hypothetical: `upload_dataset` and
/// `add_supporting_file` both passed the ACTOR into an `owner_id` parameter, and
/// because both sit behind `require_can_edit` (owner ∪ `edit`-sharee) an
/// edit-sharee's upload addressed the frame to themselves — and since
/// `sharee_user_ids` does not contain the owner either, **the dataset's owner was
/// never told at all**. A single-user test cannot see that; only a second user can.
///
/// It also fixes where `origin` belongs. `origin` is the acting connection, skipped
/// so the acting tab does not refetch what it just wrote (`core/sync/localEcho.ts`
/// re-emits it locally instead). Every fan-out applied it to the OWNER's frame, so
/// self-echo suppression was an owners-only property: a non-owner actor got their
/// own mutation back over the wire AND echoed it locally — a double fetch for the
/// one participant the mechanism exists to spare. Carrying the actor's identity
/// alongside their connection is what lets [`fan_out_owner_scoped`] apply `origin`
/// to whichever recipient IS the actor, owner or not.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Actor {
    /// The acting user, or `None` for a background/detached emit (a scheduler
    /// transition, an ingest completion) where nobody acted.
    pub user_id: Option<Uuid>,
    /// The acting SSE connection (`X-Sync-Connection-Id`), if the client sent one.
    pub connection: Option<Uuid>,
}

impl Actor {
    /// A user-originated mutation: `user_id` acted from `connection`.
    pub fn user(user_id: Uuid, connection: Option<Uuid>) -> Self {
        Self {
            user_id: Some(user_id),
            connection,
        }
    }

    /// A background / detached emit — nobody acted, so nothing is suppressed and
    /// every recipient (including the owner) refetches.
    pub fn detached() -> Self {
        Self::default()
    }

    /// The `origin` to stamp on the frame addressed to `recipient`: the acting
    /// connection when `recipient` IS the actor, else `None` (they must refetch).
    fn origin_for(self, recipient: Uuid) -> Option<Uuid> {
        if self.user_id == Some(recipient) {
            self.connection
        } else {
            None
        }
    }
}

/// Fan ONE owner-scoped change to `owner_id` ∪ `others` (sharees / accepted share
/// recipients), stamping `origin` on exactly the actor's frame.
///
/// The single implementation of the fan-out rule — `dataset`, `project` and
/// `workstore` each had their own copy, and each copy independently pinned `origin`
/// to the owner. Duplicates are deduped, so a recipient who is also the owner is
/// delivered once (the old code special-cased only `uid == owner_id`, which stopped
/// being the right comparison the moment the owner was not the actor).
pub fn fan_out_owner_scoped(
    entity: SyncEntity,
    action: SyncAction,
    id: Uuid,
    owner_id: Uuid,
    others: &[Uuid],
    actor: Actor,
) {
    for (uid, origin) in fan_out_plan(owner_id, others, actor) {
        publish(entity, action, id, Audience::owner(uid), origin);
    }
}

/// Shape a resolved AUDIENCE into the `(anchor, others)` pair
/// [`fan_out_owner_scoped`] consumes, or `None` when the audience is empty.
///
/// The pure half of #167/#168's audience fix, shared by
/// `project::scope::project_audience`, `dataset::sync::dataset_audience` and
/// `JobRepository::visible_to_user_ids`. Those three used to return the ROW's
/// `owner_id` in the anchor slot unconditionally, which is why a member removed from
/// an account kept receiving live frames for everything they had created there: the
/// anchor was derived from a column that a removal does not touch. They now compute
/// the audience from CURRENT membership ∪ shares and hand it here.
///
/// `preferred` is the row's own owner. It becomes the anchor **iff it is actually in
/// the audience** — so the ordinary case (the creator is still a member) is
/// byte-identical to the old behaviour, including `origin` self-echo suppression —
/// and otherwise the first remaining recipient anchors instead. Slot 0 carries no
/// privilege in [`fan_out_plan`]: it dedupes and stamps `origin` on whichever
/// recipient IS the actor, owner or not. An EMPTY audience yields `None`, which is
/// the state that previously could not be expressed and was therefore expressed as
/// "address the ex-owner".
pub fn owner_scoped_audience(preferred: Uuid, audience: Vec<Uuid>) -> Option<(Uuid, Vec<Uuid>)> {
    let anchor = if audience.contains(&preferred) {
        preferred
    } else {
        *audience.first()?
    };
    let others = audience.into_iter().filter(|u| *u != anchor).collect();
    Some((anchor, others))
}

/// WHO gets a frame and with which `origin` — the whole fan-out rule as a pure
/// function, so it is unit-testable without a live registry. [`fan_out_owner_scoped`]
/// is this plus one `publish` per entry.
fn fan_out_plan(owner_id: Uuid, others: &[Uuid], actor: Actor) -> Vec<(Uuid, Option<Uuid>)> {
    let mut plan: Vec<(Uuid, Option<Uuid>)> = Vec::with_capacity(others.len() + 1);
    for uid in std::iter::once(owner_id).chain(others.iter().copied()) {
        if plan.iter().any(|(u, _)| *u == uid) {
            continue;
        }
        plan.push((uid, actor.origin_for(uid)));
    }
    plan
}

/// Fan a `Session` permissions-changed signal out to many users at once (used
/// by group-permission edits that affect every member, and by `txresbench-auth`'s
/// session fan-out through `sync::auth_sink`). Delivers via a SINGLE registry
/// lock acquisition rather than one `publish` per user.
pub fn publish_session_to_users(user_ids: &[Uuid], origin: Option<Uuid>) {
    super::surface::registry()
        .deliver_session_to_users::<super::surface::CytoSyncSurface>(user_ids, origin);
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------- the fan-out rule (owner vs actor, and origin) ----------------

    fn ids(n: usize) -> Vec<Uuid> {
        (0..n).map(|_| Uuid::new_v4()).collect()
    }

    /// THE regression this whole change exists for: whoever acted, the OWNER is in
    /// the plan. On the buggy shape the caller passed the actor as `owner_id` and the
    /// owner appeared nowhere, because `sharee_user_ids` excludes the owner too.
    #[test]
    fn the_owner_is_always_a_recipient_even_when_a_sharee_acts() {
        let v = ids(3);
        let (owner, sharee_a, sharee_b) = (v[0], v[1], v[2]);
        let conn = Uuid::new_v4();
        let plan = fan_out_plan(
            owner,
            &[sharee_a, sharee_b],
            Actor::user(sharee_a, Some(conn)),
        );
        assert!(
            plan.iter().any(|(u, _)| *u == owner),
            "the dataset's owner must be told when a sharee edits it"
        );
        assert_eq!(plan.len(), 3, "owner + both sharees, once each");
    }

    /// TEST-16 — the three branches of [`owner_scoped_audience`], the pure half of
    /// #167/#168's audience fix. It is what makes "nobody may see this row" a state
    /// the type system can carry, instead of the state that was silently expressed as
    /// "address the row's ex-owner".
    #[test]
    fn owner_scoped_audience_prefers_the_row_owner_and_refuses_an_empty_set() {
        let v = ids(3);
        let (owner, a, b) = (v[0], v[1], v[2]);

        // (1) the owner IS in the audience → they anchor, exactly as before the fix,
        // and are not duplicated into `others`.
        let (anchor, others) =
            owner_scoped_audience(owner, vec![a, owner, b]).expect("non-empty audience");
        assert_eq!(anchor, owner, "the row's own owner keeps the anchor slot");
        assert!(
            !others.contains(&owner) && others.len() == 2,
            "…and is carried once, never duplicated into the recipient list"
        );

        // (2) the owner is NOT in the audience (they were removed from the account) →
        // someone else anchors and the ex-owner appears NOWHERE. This is the whole
        // point: the previous shape had no way to express this and put them in slot 0.
        let (anchor, others) =
            owner_scoped_audience(owner, vec![a, b]).expect("non-empty audience");
        assert!(anchor == a || anchor == b, "a remaining recipient anchors");
        assert!(
            anchor != owner && !others.contains(&owner),
            "the ex-owner is not addressed at all — not as anchor, not as recipient"
        );
        assert_eq!(others.len(), 1, "and the other recipient is kept");

        // (3) an EMPTY audience is `None`, not a frame addressed to the ex-owner.
        assert!(
            owner_scoped_audience(owner, Vec::new()).is_none(),
            "an empty audience yields None so the caller can skip the emit"
        );
    }

    /// `origin` follows the ACTOR. Pinned to the owner instead, the acting sharee
    /// receives their own mutation over the wire AND echoes it locally.
    #[test]
    fn origin_is_stamped_on_the_actors_frame_not_the_owners() {
        let v = ids(2);
        let (owner, sharee) = (v[0], v[1]);
        let conn = Uuid::new_v4();
        let plan = fan_out_plan(owner, &[sharee], Actor::user(sharee, Some(conn)));
        let origin_of = |u: Uuid| plan.iter().find(|(x, _)| *x == u).unwrap().1;
        assert_eq!(
            origin_of(sharee),
            Some(conn),
            "the ACTOR's frame carries origin"
        );
        assert_eq!(origin_of(owner), None, "a non-actor must refetch");
    }

    /// The owner acting on their own row keeps the property `origin` was built for.
    #[test]
    fn an_acting_owner_still_gets_their_own_origin() {
        let v = ids(2);
        let (owner, sharee) = (v[0], v[1]);
        let conn = Uuid::new_v4();
        let plan = fan_out_plan(owner, &[sharee], Actor::user(owner, Some(conn)));
        assert_eq!(plan[0], (owner, Some(conn)));
        assert_eq!(plan[1], (sharee, None));
    }

    /// A background emit suppresses nothing — every recipient refetches.
    #[test]
    fn a_detached_emit_suppresses_nobody() {
        let v = ids(2);
        let plan = fan_out_plan(v[0], &[v[1]], Actor::detached());
        assert!(plan.iter().all(|(_, o)| o.is_none()));
    }

    /// An admin acting from outside the audience is not added to it, and nothing is
    /// suppressed — their connection matches no recipient.
    #[test]
    fn an_actor_outside_the_audience_neither_joins_it_nor_suppresses() {
        let v = ids(3);
        let (owner, sharee, admin) = (v[0], v[1], v[2]);
        let plan = fan_out_plan(owner, &[sharee], Actor::user(admin, Some(Uuid::new_v4())));
        assert_eq!(plan.len(), 2, "the admin is not a recipient");
        assert!(plan.iter().all(|(_, o)| o.is_none()));
    }

    /// A recipient listed twice (or equal to the owner) is delivered once. The old
    /// per-module loops skipped only `uid == owner_id`, which stopped being the right
    /// comparison the moment the owner was not the actor.
    #[test]
    fn duplicate_recipients_are_delivered_once() {
        let v = ids(2);
        let (owner, sharee) = (v[0], v[1]);
        let plan = fan_out_plan(owner, &[sharee, owner, sharee], Actor::detached());
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].0, owner, "the owner is delivered first");
    }

    /// An actor with no connection id (a client that sent no header) suppresses
    /// nothing — `None` origin means "deliver to everyone including the actor".
    #[test]
    fn an_actor_without_a_connection_suppresses_nothing() {
        let v = ids(2);
        let plan = fan_out_plan(v[0], &[v[1]], Actor::user(v[1], None));
        assert!(plan.iter().all(|(_, o)| o.is_none()));
    }

    #[test]
    fn entity_names_match_the_frontend_sync_vocabulary() {
        let cases = [
            (SyncEntity::Project, "project"),
            (SyncEntity::Draft, "draft"),
            (SyncEntity::Dataset, "dataset"),
            (SyncEntity::DatasetFolder, "dataset_folder"),
            (SyncEntity::ProjectShare, "project_share"),
            (SyncEntity::ProjectTransfer, "project_transfer"),
            (SyncEntity::ProjectSettings, "project_settings"),
            (SyncEntity::Notification, "notification"),
            (SyncEntity::Session, "session"),
            // P1 workstore catalog artifact (project-scoped emit). The FE
            // subscribes to `sync:artifact`.
            (SyncEntity::Artifact, "artifact"),
            // P4 provenance run node + settings singleton.
            (SyncEntity::Provenance, "provenance"),
            (
                SyncEntity::ProvenanceVerification,
                "provenance_verification",
            ),
            (SyncEntity::ProvenanceSettings, "provenance_settings"),
            // Accounts epic A1 (vocabulary only; emitted by A4).
            (SyncEntity::Account, "account"),
            (SyncEntity::AccountMember, "account_member"),
            // The auth-domain entities `txresbench-auth` publishes through
            // `AuthSyncSink` (mapped in `sync::auth_sink`). Their wire names are
            // what the FE `sync:<entity>` subscriptions key on, so a rename here
            // silently unwires those stores.
            (SyncEntity::Profile, "profile"),
            (SyncEntity::SessionSettings, "session_settings"),
            (SyncEntity::User, "user"),
            (SyncEntity::Group, "group"),
            (SyncEntity::AuthProvider, "auth_provider"),
        ];
        for (e, name) in cases {
            assert_eq!(serde_json::to_string(&e).unwrap(), format!("\"{name}\""));
        }
    }

    #[test]
    fn action_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&SyncAction::Create).unwrap(),
            "\"create\""
        );
        assert_eq!(
            serde_json::to_string(&SyncAction::Update).unwrap(),
            "\"update\""
        );
        assert_eq!(
            serde_json::to_string(&SyncAction::Delete).unwrap(),
            "\"delete\""
        );
    }

    #[test]
    fn wire_payload_is_notify_only_three_keys() {
        let e = SyncEvent {
            entity: SyncEntity::Project,
            action: SyncAction::Update,
            id: Uuid::nil(),
        };
        let json = serde_json::to_string(&e).unwrap();
        let obj: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(
            obj.len(),
            3,
            "only entity/action/id may cross the wire: {json}"
        );
        assert!(json.contains("\"entity\":\"project\""), "{json}");
    }
}
