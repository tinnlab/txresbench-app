import { SaasApiClient } from "@/api-client-saas/client";
import type {
	BillingIntegrationView,
	TestConnectionResponse,
	UpdateBillingIntegrationRequest,
} from "@/api-client-saas/types";
import { hasPermissionNow, type PermissionExpr } from "@/core/permissions";
import { defineStore, registerLazyStore } from "@ziee/framework/store-kit";

// saas-only permission STRING (absent from the OSS `Permissions` enum, so referenced
// as a string per the #50 seam / admin-console-shell §"saas-gating seam").
const BILLING_ADMIN = "billing::admin" as PermissionExpr;

/**
 * The deployment-level Billing-integration config singleton for the admin page (#60).
 *
 * SECURITY: this store only ever holds the MASKED view (`configured`/`last4`/
 * `connected`/`prices`) — never a plaintext secret. A secret the admin TYPES to rotate
 * lives in component-local form state and is passed straight to the save action; it is
 * NEVER stored here. `testResult` is the `{ok,message}` view — also never the key.
 *
 * Mirrors `ProvenanceSettings.store` (refetch-on-mount + after each mutation; the
 * mutations go through permissioned `defineAction`s, not the store directly).
 */
const BillingIntegrationDef = defineStore("BillingIntegration", {
	state: {
		view: null as BillingIntegrationView | null,
		loading: false,
		saving: false,
		testing: false,
		error: null as string | null,
		testResult: null as TestConnectionResponse | null,
	},
	actions: (set) => ({
		load: async () => {
			if (!hasPermissionNow(BILLING_ADMIN)) return;
			set({ loading: true, error: null });
			try {
				const view = await SaasApiClient.Admin.getBillingIntegration();
				set({ view, loading: false });
			} catch (e) {
				set({
					error: e instanceof Error ? e.message : String(e),
					loading: false,
				});
			}
		},
		// Persist a partial update (rotate secret / edit prices). Returns success; the
		// masked view is re-read so the UI reflects the new last4 / stored state.
		save: async (update: UpdateBillingIntegrationRequest): Promise<boolean> => {
			if (!hasPermissionNow(BILLING_ADMIN)) return false;
			set({ saving: true, error: null });
			try {
				const view = await SaasApiClient.Admin.putBillingIntegration(update);
				set({ view, saving: false });
				return true;
			} catch (e) {
				set({
					error: e instanceof Error ? e.message : String(e),
					saving: false,
				});
				return false;
			}
		},
		// Validate the stored (or a just-typed candidate) key. The candidate is passed
		// through and never stored. Returns the {ok,message} view (never the key).
		test: async (
			candidate?: string,
		): Promise<TestConnectionResponse | null> => {
			if (!hasPermissionNow(BILLING_ADMIN)) return null;
			set({ testing: true, testResult: null });
			try {
				const body =
					candidate && candidate.trim() ? { stripe_secret: candidate } : {};
				const result = await SaasApiClient.Admin.testBillingIntegration(body);
				set({ testResult: result, testing: false });
				return result;
			} catch (e) {
				const result = {
					ok: false,
					message: e instanceof Error ? e.message : "Test failed",
				};
				set({ testResult: result, testing: false });
				return result;
			}
		},
	}),
	init: ({ actions }) => {
		void actions.load();
	},
});

export const useBillingIntegrationStore = BillingIntegrationDef.store;

/** The reactive store PROXY — the direct handle consumers import (built once). */
export const BillingIntegration = registerLazyStore(BillingIntegrationDef);
