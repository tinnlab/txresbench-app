import { SaasApiClient } from "@/api-client-saas/client";
import type {
	AbandonMigrationResponse,
	ComputeTestResponse,
	InfraComputeView,
	InfraObjectStoreView,
	MigrationDest,
	MigrationStatusView,
	ObjectStoreTestResponse,
	RetireSourceRequest,
	RetireSourceResponse,
	RoundtripTestResponse,
	StartMigrationResponse,
	UpdateInfraComputeRequest,
	UpdateInfraObjectStoreRequest,
} from "@/api-client-saas/types";
import { hasPermissionNow, type PermissionExpr } from "@/core/permissions";
import { defineStore, registerLazyStore } from "@ziee/framework/store-kit";

// saas-only permission STRING (absent from the OSS `Permissions` enum, so referenced as
// a string per the #50 seam / admin-console-shell §"saas-gating seam").
const INFRA_MANAGE = "infra::settings::manage" as PermissionExpr;

/**
 * The deployment INFRASTRUCTURE config singleton for the admin page (#63) — the
 * object-store (S3/GCS) + compute (Kubernetes) backend config + test-connection.
 *
 * SECURITY (mirrors `BillingIntegration.store`): this store only ever holds the two
 * MASKED views (`*_last4`/`*_configured`/`status`/non-secret config) — NEVER a plaintext
 * secret. A secret the admin TYPES to rotate lives in component-local form state and is
 * passed straight to the save/test action; it is NEVER stored here. The two `testResult`s
 * are `{ok,message}` — also never a credential.
 */
const InfraSettingsDef = defineStore("InfraSettings", {
	state: {
		objectStore: null as InfraObjectStoreView | null,
		compute: null as InfraComputeView | null,
		loading: false,
		savingObjectStore: false,
		savingCompute: false,
		testingObjectStore: false,
		testingCompute: false,
		error: null as string | null,
		objectStoreTestResult: null as ObjectStoreTestResponse | null,
		computeTestResult: null as ComputeTestResponse | null,
		// #61 — data migration (copy+verify) state + the end-to-end round-trip test.
		migration: null as MigrationStatusView | null,
		migrationBusy: false,
		roundtripResult: null as RoundtripTestResponse | null,
		roundtripBusy: false,
	},
	actions: (set) => ({
		load: async () => {
			if (!hasPermissionNow(INFRA_MANAGE)) return;
			set({ loading: true, error: null });
			try {
				const [objectStore, compute] = await Promise.all([
					SaasApiClient.Admin.getInfraObjectStore(),
					SaasApiClient.Admin.getInfraCompute(),
				]);
				set({ objectStore, compute, loading: false });
			} catch (e) {
				set({ error: e instanceof Error ? e.message : String(e), loading: false });
			}
		},

		// ── object store ──────────────────────────────────────────────
		saveObjectStore: async (
			update: UpdateInfraObjectStoreRequest,
		): Promise<boolean> => {
			if (!hasPermissionNow(INFRA_MANAGE)) return false;
			set({ savingObjectStore: true, error: null });
			try {
				const objectStore = await SaasApiClient.Admin.putInfraObjectStore(update);
				set({ objectStore, savingObjectStore: false });
				return true;
			} catch (e) {
				set({
					error: e instanceof Error ? e.message : String(e),
					savingObjectStore: false,
				});
				return false;
			}
		},
		testObjectStore: async (candidate?: {
			access_key_id?: string;
			secret_access_key?: string;
		}): Promise<ObjectStoreTestResponse | null> => {
			if (!hasPermissionNow(INFRA_MANAGE)) return null;
			set({ testingObjectStore: true, objectStoreTestResult: null });
			try {
				const result = await SaasApiClient.Admin.testInfraObjectStore(candidate ?? {});
				set({ objectStoreTestResult: result, testingObjectStore: false });
				return result;
			} catch (e) {
				const result = {
					ok: false,
					message: e instanceof Error ? e.message : "Test failed",
				};
				set({ objectStoreTestResult: result, testingObjectStore: false });
				return result;
			}
		},

		// ── compute ───────────────────────────────────────────────────
		saveCompute: async (update: UpdateInfraComputeRequest): Promise<boolean> => {
			if (!hasPermissionNow(INFRA_MANAGE)) return false;
			set({ savingCompute: true, error: null });
			try {
				const compute = await SaasApiClient.Admin.putInfraCompute(update);
				set({ compute, savingCompute: false });
				return true;
			} catch (e) {
				set({
					error: e instanceof Error ? e.message : String(e),
					savingCompute: false,
				});
				return false;
			}
		},
		testCompute: async (candidate?: {
			kubeconfig?: string;
		}): Promise<ComputeTestResponse | null> => {
			if (!hasPermissionNow(INFRA_MANAGE)) return null;
			set({ testingCompute: true, computeTestResult: null });
			try {
				const result = await SaasApiClient.Admin.testInfraCompute(candidate ?? {});
				set({ computeTestResult: result, testingCompute: false });
				return result;
			} catch (e) {
				const result = {
					ok: false,
					message: e instanceof Error ? e.message : "Test failed",
				};
				set({ computeTestResult: result, testingCompute: false });
				return result;
			}
		},
		// ── data migration (#61 §2/§3) ─────────────────────────────────
		loadMigration: async (): Promise<MigrationStatusView | null> => {
			if (!hasPermissionNow(INFRA_MANAGE)) return null;
			try {
				const migration = await SaasApiClient.Admin.getInfraMigration();
				set({ migration });
				return migration;
			} catch (e) {
				set({ error: e instanceof Error ? e.message : String(e) });
				return null;
			}
		},
		startMigration: async (
			dest: MigrationDest,
			cost_ack = false,
		): Promise<StartMigrationResponse | null> => {
			if (!hasPermissionNow(INFRA_MANAGE)) return null;
			set({ migrationBusy: true, error: null });
			try {
				const res = await SaasApiClient.Admin.startInfraMigration({ dest, cost_ack });
				set({ migration: res.started ? res.status : null, migrationBusy: false });
				return res;
			} catch (e) {
				set({ error: e instanceof Error ? e.message : String(e), migrationBusy: false });
				return null;
			}
		},
		// #64 — acknowledge the cross-cloud egress cost for a migration PARKED awaiting a cost
		// acknowledgement (`awaiting_cost_ack`), which STARTS the parked copy. Returns the updated
		// status so the caller can resume polling the now-live migration.
		ackMigrationCost: async (
			id?: string,
		): Promise<MigrationStatusView | null> => {
			if (!hasPermissionNow(INFRA_MANAGE)) return null;
			set({ migrationBusy: true, error: null });
			try {
				const migration = await SaasApiClient.Admin.ackInfraMigrationCost({ id });
				set({ migration, migrationBusy: false });
				return migration;
			} catch (e) {
				set({ error: e instanceof Error ? e.message : String(e), migrationBusy: false });
				return null;
			}
		},
		retireSource: async (
			req: RetireSourceRequest,
		): Promise<RetireSourceResponse | null> => {
			if (!hasPermissionNow(INFRA_MANAGE)) return null;
			set({ migrationBusy: true, error: null });
			try {
				const res = await SaasApiClient.Admin.retireInfraMigrationSource(req);
				await InfraSettings.loadMigration();
				set({ migrationBusy: false });
				return res;
			} catch (e) {
				set({ error: e instanceof Error ? e.message : String(e), migrationBusy: false });
				return null;
			}
		},
		// #65 — ABANDON a verified migration and revert the primary to the OLD store. On success the
		// primary IS the old store again (nothing deleted; the new store's copy is left in place) and
		// the store is reconfigurable, so reload BOTH the migration status and the object-store config
		// (the effective backend reverted to the old store).
		abandonMigration: async (confirm: boolean): Promise<AbandonMigrationResponse | null> => {
			if (!hasPermissionNow(INFRA_MANAGE)) return null;
			set({ migrationBusy: true, error: null });
			try {
				// Pass the confirmation THROUGH so the backend's ABANDON_NOT_CONFIRMED guard is real
				// for every client (an AI/MCP invoke with confirm:false is refused, not force-abandoned).
				const res = await SaasApiClient.Admin.abandonInfraMigration({ confirm });
				await Promise.all([InfraSettings.loadMigration(), InfraSettings.load()]);
				set({ migrationBusy: false });
				return res;
			} catch (e) {
				set({ error: e instanceof Error ? e.message : String(e), migrationBusy: false });
				return null;
			}
		},
		roundtripTest: async (): Promise<RoundtripTestResponse | null> => {
			if (!hasPermissionNow(INFRA_MANAGE)) return null;
			set({ roundtripBusy: true, roundtripResult: null });
			try {
				const result = await SaasApiClient.Admin.roundtripTestInfra();
				set({ roundtripResult: result, roundtripBusy: false });
				return result;
			} catch (e) {
				const result = { ok: false, message: e instanceof Error ? e.message : "Round-trip failed" };
				set({ roundtripResult: result, roundtripBusy: false });
				return result;
			}
		},
	}),
	init: ({ actions }) => {
		void actions.load();
		void actions.loadMigration();
	},
});

export const useInfraSettingsStore = InfraSettingsDef.store;

/** The reactive store PROXY — the direct handle consumers import (built once). */
export const InfraSettings = registerLazyStore(InfraSettingsDef);
