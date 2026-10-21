// TEST-11 [covers: ITEM-9] — the BillingIntegration store maps the MASKED view,
// gates on billing::admin, and holds NO plaintext secret. A rotate draft lives in the
// component, never the store.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ permOk: true }));
const api = vi.hoisted(() => ({
	getBillingIntegration: vi.fn(),
	putBillingIntegration: vi.fn(),
	testBillingIntegration: vi.fn(),
}));

vi.mock("@/core/permissions", () => ({
	hasPermissionNow: (_p: string) => h.permOk,
}));
vi.mock("@/api-client-saas/client", () => ({ SaasApiClient: { Admin: api } }));

const { BillingIntegration, useBillingIntegrationStore } = await import(
	"./BillingIntegration.store"
);

const view = {
	configured: true,
	last4: "4242",
	webhook_configured: false,
	connected: "database",
	prices: { STRIPE_PRICE_PRO_BASE: "price_x" },
};

beforeEach(() => {
	h.permOk = true;
	Object.values(api).forEach((f) => f.mockReset());
	useBillingIntegrationStore.setState({
		view: null,
		loading: false,
		saving: false,
		testing: false,
		error: null,
		testResult: null,
	} as never);
});

describe("TEST-11 — BillingIntegration store", () => {
	it("loads and maps the masked view (never a plaintext secret)", async () => {
		api.getBillingIntegration.mockResolvedValue(view);
		await BillingIntegration.load();
		const s = useBillingIntegrationStore.getState();
		expect(s.view).toEqual(view);
		// The store shape has no field that could carry a plaintext secret.
		expect(JSON.stringify(s)).not.toContain("sk_");
	});

	it("skips the load without billing::admin", async () => {
		h.permOk = false;
		await BillingIntegration.load();
		expect(api.getBillingIntegration).not.toHaveBeenCalled();
	});

	it("save passes the update through and re-reads the masked view", async () => {
		const updated = { ...view, last4: "9999" };
		api.putBillingIntegration.mockResolvedValue(updated);
		const ok = await BillingIntegration.save({ stripe_secret: "sk_live_new" });
		expect(ok).toBe(true);
		expect(api.putBillingIntegration).toHaveBeenCalledWith({
			stripe_secret: "sk_live_new",
		});
		expect(useBillingIntegrationStore.getState().view).toEqual(updated);
	});

	it("save is refused without billing::admin", async () => {
		h.permOk = false;
		const ok = await BillingIntegration.save({ stripe_secret: "sk_live_new" });
		expect(ok).toBe(false);
		expect(api.putBillingIntegration).not.toHaveBeenCalled();
	});

	it("test passes a candidate through and stores only the {ok,message} result", async () => {
		api.testBillingIntegration.mockResolvedValue({
			ok: true,
			message: "Connection succeeded",
		});
		const r = await BillingIntegration.test("sk_live_candidate");
		expect(api.testBillingIntegration).toHaveBeenCalledWith({
			stripe_secret: "sk_live_candidate",
		});
		expect(r).toEqual({ ok: true, message: "Connection succeeded" });
		// The candidate secret is NOT persisted into the store.
		expect(JSON.stringify(useBillingIntegrationStore.getState())).not.toContain(
			"sk_live_candidate",
		);
	});

	it("test with no candidate sends an empty body (tests the stored/env key)", async () => {
		api.testBillingIntegration.mockResolvedValue({
			ok: false,
			message: "Invalid key (401)",
		});
		await BillingIntegration.test();
		expect(api.testBillingIntegration).toHaveBeenCalledWith({});
	});
});
