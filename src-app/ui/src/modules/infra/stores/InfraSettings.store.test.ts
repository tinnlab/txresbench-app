// TEST-19 [covers: ITEM-11, ITEM-12] — the InfraSettings store calls SaasApiClient for
// each surface, maps the masked views + {ok,message} results into state, and NEVER stores
// a plaintext secret field. Mirrors the billing-integration store contract.

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getInfraObjectStore: vi.fn(),
	putInfraObjectStore: vi.fn(),
	testInfraObjectStore: vi.fn(),
	getInfraCompute: vi.fn(),
	putInfraCompute: vi.fn(),
	testInfraCompute: vi.fn(),
	getInfraMigration: vi.fn(),
	ackInfraMigrationCost: vi.fn(),
	retireInfraMigrationSource: vi.fn(),
	abandonInfraMigration: vi.fn(),
}));

vi.mock("@/api-client-saas/client", () => ({ SaasApiClient: { Admin: api } }));
vi.mock("@/core/permissions", () => ({
	hasPermissionNow: () => true,
}));

const OBJECT_VIEW = {
	backend: "s3",
	provider: "s3",
	endpoint: "http://minio:9000",
	bucket: "cyto-worklab",
	region: "us-east-1",
	path_style: true,
	access_key_configured: true,
	access_key_last4: "MPLE",
	secret_key_configured: true,
	status: "database",
};
const COMPUTE_VIEW = {
	backend: "kubernetes",
	cluster_endpoint: "https://k8s:6443",
	namespace: "cyto",
	worker_image: "cytoanalyst-worker:latest",
	kubeconfig_configured: true,
	token_configured: true,
	token_last4: "6789",
	status: "database",
};

import { InfraSettings } from "./InfraSettings.store";

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
});

describe("TEST-19 — InfraSettings store", () => {
	it("load() fetches both masked views via SaasApiClient and stores no secret field", async () => {
		api.getInfraObjectStore.mockResolvedValue(OBJECT_VIEW);
		api.getInfraCompute.mockResolvedValue(COMPUTE_VIEW);

		await InfraSettings.load();

		expect(api.getInfraObjectStore).toHaveBeenCalled();
		expect(api.getInfraCompute).toHaveBeenCalled();
		expect(InfraSettings.$.objectStore?.access_key_last4).toBe("MPLE");
		expect(InfraSettings.$.compute?.token_last4).toBe("6789");
		// The stored state carries no plaintext secret field.
		const serialized = JSON.stringify(InfraSettings.$);
		expect(serialized).not.toContain("secret_access_key");
		expect(serialized).not.toContain("kubeconfig\":");
		expect(serialized.toLowerCase()).not.toContain("ciphertext");
	});

	it("testObjectStore()/testCompute() store the {ok,message} result, never a secret", async () => {
		api.testInfraObjectStore.mockResolvedValue({ ok: false, message: "Connection failed — bucket not found." });
		api.testInfraCompute.mockResolvedValue({ ok: true, message: "Connection succeeded." });

		const r1 = await InfraSettings.testObjectStore({ access_key_id: "AKIA_typed_candidate" });
		expect(api.testInfraObjectStore).toHaveBeenCalledWith({ access_key_id: "AKIA_typed_candidate" });
		expect(r1?.ok).toBe(false);
		expect(InfraSettings.$.objectStoreTestResult?.message).toContain("bucket not found");

		await InfraSettings.testCompute({ kubeconfig: "apiVersion: v1" });
		expect(InfraSettings.$.computeTestResult?.ok).toBe(true);
		// The typed candidate is passed through but never persisted into store state.
		expect(JSON.stringify(InfraSettings.$)).not.toContain("AKIA_typed_candidate");
	});
});

// TEST-CUT [covers: #64] — the live-cutover store additions. `ackMigrationCost` acknowledges the
// egress cost and stores the returned (now-live) status; `loadMigration` + `retireSource` back the
// status card. No credential is ever persisted into store state.
const CUTOVER_VIEW = {
	active: true,
	auto_started: true,
	awaiting_cost_ack: false,
	blobs_done: 0,
	blobs_total: 100,
	bytes_done: 0,
	bytes_total: 1_000_000,
	cost_ack: true,
	cross_cloud: true,
	cutover: false,
	dst_backend: "s3",
	dst_bucket: "cyto-new",
	dst_provider: "gcs",
	id: "mig-1",
	phase: "copying",
	src_backend: "s3",
};

describe("TEST-CUT — InfraSettings live-cutover (#64)", () => {
	it("ackMigrationCost() posts the ack and stores the returned live status", async () => {
		api.ackInfraMigrationCost.mockResolvedValue(CUTOVER_VIEW);

		const res = await InfraSettings.ackMigrationCost("mig-1");

		expect(api.ackInfraMigrationCost).toHaveBeenCalledWith({ id: "mig-1" });
		expect(res?.phase).toBe("copying");
		expect(InfraSettings.$.migration?.awaiting_cost_ack).toBe(false);
		expect(InfraSettings.$.migrationBusy).toBe(false);
	});

	it("ackMigrationCost() passes an absent id through (newest parked migration)", async () => {
		api.ackInfraMigrationCost.mockResolvedValue(CUTOVER_VIEW);
		await InfraSettings.ackMigrationCost();
		expect(api.ackInfraMigrationCost).toHaveBeenCalledWith({ id: undefined });
	});

	it("ackMigrationCost() records the error and clears busy on failure", async () => {
		api.ackInfraMigrationCost.mockRejectedValue(new Error("egress ack rejected"));
		const res = await InfraSettings.ackMigrationCost("mig-1");
		expect(res).toBeNull();
		expect(InfraSettings.$.error).toContain("egress ack rejected");
		expect(InfraSettings.$.migrationBusy).toBe(false);
	});

	it("loadMigration() stores the masked cutover status", async () => {
		api.getInfraMigration.mockResolvedValue({ ...CUTOVER_VIEW, cutover: true, phase: "verified" });
		const res = await InfraSettings.loadMigration();
		expect(res?.cutover).toBe(true);
		expect(InfraSettings.$.migration?.cutover).toBe(true);
		// The status view carries no plaintext secret.
		expect(JSON.stringify(InfraSettings.$)).not.toContain("secret_access_key");
	});

	it("retireSource() returns the readiness result and reloads the migration", async () => {
		api.retireInfraMigrationSource.mockResolvedValue({ safe_to_retire: true, verified_blobs: 100, message: "safe" });
		api.getInfraMigration.mockResolvedValue({ ...CUTOVER_VIEW, cutover: true });
		const res = await InfraSettings.retireSource({ confirm: true, dest: { provider: "gcs", bucket: "cyto-new" } });
		expect(res?.safe_to_retire).toBe(true);
		expect(api.retireInfraMigrationSource).toHaveBeenCalled();
		expect(api.getInfraMigration).toHaveBeenCalled();
	});
});

// TEST-FE1 — cutover store slice + ackMigrationCost (#64 ITEM-8)

// TEST-6 [covers: ITEM-4, ITEM-5] — abandonMigration (#65): posts confirm:true, reloads BOTH the
// migration status and the object-store config (the effective backend reverted to the old store),
// and records the error on failure. Imports the regenerated AbandonMigrationResponse type via the
// client typing (this file typechecks only if `just openapi-regen` kept the DTO — binding ITEM-4).
describe("TEST-6 — InfraSettings abandonMigration (#65)", () => {
	it("abandonMigration() posts confirm:true and reloads migration + object-store config", async () => {
		api.abandonInfraMigration.mockResolvedValue({
			abandoned: true,
			reverted_to: "local",
			config_reverted: true,
			message: "Reverted to the old store.",
		});
		api.getInfraMigration.mockResolvedValue({ ...CUTOVER_VIEW, phase: "abandoned", cutover: false });
		api.getInfraObjectStore.mockResolvedValue(OBJECT_VIEW);
		api.getInfraCompute.mockResolvedValue(COMPUTE_VIEW);

		const res = await InfraSettings.abandonMigration(true);

		expect(api.abandonInfraMigration).toHaveBeenCalledWith({ confirm: true });
		expect(res?.abandoned).toBe(true);
		expect(res?.reverted_to).toBe("local");
		expect(api.getInfraMigration).toHaveBeenCalled();
		expect(api.getInfraObjectStore).toHaveBeenCalled();
		expect(InfraSettings.$.migrationBusy).toBe(false);
	});

	it("abandonMigration(false) passes confirm:false THROUGH (the backend guard stays real)", async () => {
		api.abandonInfraMigration.mockRejectedValue(
			Object.assign(new Error("ABANDON_NOT_CONFIRMED"), { code: "ABANDON_NOT_CONFIRMED" }),
		);
		await InfraSettings.abandonMigration(false);
		// The store does NOT force confirm:true — a false value reaches the backend, which refuses it.
		expect(api.abandonInfraMigration).toHaveBeenCalledWith({ confirm: false });
	});

	it("abandonMigration() records the error and clears busy on failure", async () => {
		api.abandonInfraMigration.mockRejectedValue(new Error("old store unavailable"));
		const res = await InfraSettings.abandonMigration(true);
		expect(res).toBeNull();
		expect(InfraSettings.$.error).toContain("old store unavailable");
		expect(InfraSettings.$.migrationBusy).toBe(false);
	});
});
