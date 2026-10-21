import { z } from "zod";
// The SAAS permission enum — carries `infra::settings::manage` (absent from the default
// `@/api-client/permissions`). collect-actions validates each action's permission VALUE
// against the UNION of both generated enums (#50), so these live in the single committed
// manifest and are AI-drivable on the hosted build.
import { Permissions } from "@/api-client-saas/permissions";
import { defineAction } from "../defineAction";
import { InfraSettings } from "@/modules/infra/stores/InfraSettings.store";

// The admin Infrastructure config mutations (#63) — declared ONCE as permissioned
// `defineAction`s so they are EQUALLY drivable by a human (form button / ⌘K) and the AI
// agent, never a bare inline onClick (`.claude/skills/ai-controllable-actions`). Each
// `run` is a THIN wrapper over the SAME store method the card calls. SECURITY: a secret
// param is passed straight to the API and never persisted client-side; the store only
// ever holds the masked view.
//
// Sole runtime import site: `src/modules/infra/module.tsx` (presence-gated).

defineAction({
	id: "infra.updateObjectStore",
	title: "Update the object-store backend config (S3/GCS)",
	permission: Permissions.InfraSettingsManage,
	mutating: true,
	// Rotating a cloud credential / switching the store backend is a dangerous write — a
	// wrong value can strand the data plane. A blank secret means "leave unchanged".
	dangerous: true,
	surfaces: { palette: true, ai: true },
	group: "Admin",
	description:
		"Set/rotate the object-store backend config: backend/provider/endpoint/bucket/region " +
		"and the S3 access-key/secret-key (stored ENCRYPTED at rest). A blank/absent secret " +
		"leaves the stored credential unchanged. Never returns the plaintext.",
	params: z.object({
		backend: z.string().optional().describe("'local' or 's3'. Absent ⇒ unchanged."),
		provider: z.string().optional().describe("'s3' or 'gcs'. Absent ⇒ unchanged."),
		endpoint: z.string().optional().describe("Endpoint override URL. Absent ⇒ unchanged."),
		bucket: z.string().optional(),
		region: z.string().optional(),
		path_style: z.boolean().optional(),
		access_key_id: z
			.string()
			.optional()
			.describe("A NEW access key to store (encrypted). Blank/absent ⇒ unchanged."),
		secret_access_key: z
			.string()
			.optional()
			.describe("A NEW secret key to store (encrypted). Blank/absent ⇒ unchanged."),
	}),
	run: async (update) => InfraSettings.saveObjectStore(update),
});

defineAction({
	id: "infra.testObjectStore",
	title: "Test the object-store connection",
	permission: Permissions.InfraSettingsManage,
	mutating: true, // makes an outbound round-trip (put/get/delete); not a pure local read
	surfaces: { palette: true, ai: true },
	group: "Admin",
	description:
		"Test the configured object store with a put/get/delete round-trip. Optionally " +
		"override the credentials with just-typed candidates (not persisted). Returns " +
		"{ok,message} — never the secret.",
	params: z.object({
		access_key_id: z
			.string()
			.optional()
			.describe("A candidate access key to test WITHOUT storing. Absent ⇒ stored/env."),
		secret_access_key: z
			.string()
			.optional()
			.describe("A candidate secret key to test WITHOUT storing."),
	}),
	run: async (candidate) => InfraSettings.testObjectStore(candidate),
});

defineAction({
	id: "infra.updateCompute",
	title: "Update the compute backend config (Kubernetes)",
	permission: Permissions.InfraSettingsManage,
	mutating: true,
	dangerous: true,
	surfaces: { palette: true, ai: true },
	group: "Admin",
	description:
		"Set/rotate the compute backend config: backend/cluster-endpoint/namespace/worker-image " +
		"and the kubeconfig/cluster-token (stored ENCRYPTED at rest). A blank/absent secret " +
		"leaves the stored credential unchanged. Never returns the plaintext.",
	params: z.object({
		backend: z.string().optional().describe("'local' or 'kubernetes'. Absent ⇒ unchanged."),
		cluster_endpoint: z.string().optional(),
		namespace: z.string().optional(),
		worker_image: z.string().optional(),
		kubeconfig: z
			.string()
			.optional()
			.describe("A NEW kubeconfig to store (encrypted). Blank/absent ⇒ unchanged."),
		token: z
			.string()
			.optional()
			.describe("A NEW cluster token to store (encrypted). Blank/absent ⇒ unchanged."),
	}),
	run: async (update) => InfraSettings.saveCompute(update),
});

defineAction({
	id: "infra.testCompute",
	title: "Test the compute cluster connection",
	permission: Permissions.InfraSettingsManage,
	mutating: true,
	surfaces: { palette: true, ai: true },
	group: "Admin",
	description:
		"Test the configured compute cluster by reaching the API and listing nodes. " +
		"Optionally override the kubeconfig with a just-typed candidate (not persisted). " +
		"Returns {ok,message} — never the credential.",
	params: z.object({
		kubeconfig: z
			.string()
			.optional()
			.describe("A candidate kubeconfig to test WITHOUT storing. Absent ⇒ stored/ambient."),
	}),
	run: async (candidate) => InfraSettings.testCompute(candidate),
});

// ── #61 — round-trip test + data migration (copy+verify) + retire-source ──────────────
//
// The migration mutations are DANGEROUS (a data move / a data deletion): the palette
// interposes a confirmation, and the AI agent sees the danger flag. The migration ENGINE
// never deletes the source during copy+verify — only the explicitly-confirmed retire step
// deletes it, and only after a full re-verify proves every blob is safe in the destination.

const migrationDest = z.object({
	provider: z.string().optional().describe("'s3' or 'gcs'."),
	endpoint: z.string().optional(),
	bucket: z.string().optional(),
	region: z.string().optional(),
	path_style: z.boolean().optional(),
	access_key_id: z.string().optional().describe("Destination access key (used only to build the store handle; not persisted here)."),
	secret_access_key: z.string().optional(),
});

defineAction({
	id: "infra.roundtripTest",
	title: "Round-trip test the compute↔storage pair",
	permission: Permissions.InfraSettingsManage,
	mutating: true, // writes + reads + deletes a probe blob through the selected store
	surfaces: { palette: true, ai: true },
	group: "Admin",
	description:
		"Prove the SELECTED compute backend can write to AND read from the SELECTED object store " +
		"(a real put/get/verify/delete round-trip through the pair) — the end-to-end check two " +
		"green per-service tests can't give. Returns {ok,message}.",
	params: z.object({}),
	run: async () => InfraSettings.roundtripTest(),
});

defineAction({
	id: "infra.startMigration",
	title: "Migrate object-store data to a new store",
	permission: Permissions.InfraSettingsManage,
	mutating: true,
	// A data move (copy+verify) to a new store — large cross-cloud moves bill egress and are
	// cost-gated. The source is NEVER deleted by this action.
	dangerous: true,
	surfaces: { palette: true, ai: true },
	group: "Admin",
	description:
		"Start a copy+verify data migration from the CURRENT object store to a destination store. " +
		"Every blob is copied under its content-addressed key and verified by content hash; a " +
		"mismatch halts and rolls back. The source is never deleted. A large cross-cloud move " +
		"requires cost_ack:true (surfaced as an estimate first).",
	params: z.object({
		dest: migrationDest,
		cost_ack: z.boolean().optional().describe("Explicit go-ahead for a large cross-cloud (egress-billing) move."),
	}),
	run: async ({ dest, cost_ack }) => InfraSettings.startMigration(dest, cost_ack ?? false),
});

defineAction({
	id: "infra.ackMigrationCost",
	title: "Acknowledge egress cost & start the parked migration",
	permission: Permissions.InfraSettingsManage,
	mutating: true,
	// Acknowledging the cost STARTS a real cross-cloud data move that bills egress — a
	// deliberate, cost-incurring go-ahead, so it carries the danger flag like the other
	// migration mutations. The source is NEVER deleted by this action.
	dangerous: true,
	surfaces: { palette: true, ai: true },
	group: "Admin",
	description:
		"Acknowledge the cross-cloud EGRESS COST for a migration PARKED awaiting a cost " +
		"acknowledgement (`awaiting_cost_ack`) and START the copy. Use after reviewing the " +
		"estimate (blobs + bytes). Returns the updated migration status.",
	params: z.object({
		id: z
			.string()
			.optional()
			.describe("The parked (pending) migration to acknowledge + start. Absent ⇒ the newest pending one."),
	}),
	run: async ({ id }) => InfraSettings.ackMigrationCost(id),
});

defineAction({
	id: "infra.retireSourceStore",
	title: "Confirm the old object store is safe to retire",
	permission: Permissions.InfraSettingsManage,
	mutating: true,
	surfaces: { palette: true, ai: true },
	group: "Admin",
	// This action DELETES NOTHING. It PROVES the old store is safe to retire (every blob is
	// verified present in the destination) after a verified migration + the in-flight-job fence,
	// and hands back the go-ahead — the actual deletion of the old store is a deliberate MANUAL
	// operator step (never automatic; never from the API), so there is no data-loss path.
	description:
		"After a verified migration, confirm the OLD object store is SAFE to retire: re-verifies " +
		"every blob is present in the destination and that no jobs are running. Deletes nothing — " +
		"returns {safe_to_retire, verified_blobs}. The old store is then deleted MANUALLY.",
	params: z.object({
		confirm: z.boolean().describe("Must be true to run the retire-readiness check."),
		dest: migrationDest.describe("The destination every blob must be verified present in."),
	}),
	run: async (req) => InfraSettings.retireSource(req),
});

defineAction({
	id: "infra.abandonMigration",
	title: "Cancel / revert migration to the old object store",
	permission: Permissions.InfraSettingsManage,
	mutating: true,
	// ABANDON a verified live cutover: atomically reverts the primary to the OLD store. Dangerous —
	// it changes the live data plane back — so the palette interposes a confirm and the AI sees the
	// flag. SAFE by construction: the old store is never deleted and the NEW store's copy is left in
	// place; nothing is deleted on this path.
	dangerous: true,
	surfaces: { palette: true, ai: true },
	group: "Admin",
	description:
		"Abandon a verified object-store migration and revert the primary back to the OLD store " +
		"(atomic swap; no restart). Use after cutting over live and changing your mind. The old store " +
		"is never deleted and the new store's copy is left in place — nothing is deleted. Clears the " +
		"config-change block so the store can be reconfigured. Returns {abandoned, reverted_to, config_reverted}.",
	params: z.object({
		confirm: z.boolean().describe("Must be true to abandon the migration and revert to the old store."),
	}),
	// Honor confirm: a false/omitted value must NOT abandon — the store passes it through so the
	// backend's explicit-confirmation guard (ABANDON_NOT_CONFIRMED) is real on the AI/MCP path too.
	run: async ({ confirm }) => InfraSettings.abandonMigration(confirm ?? false),
});
