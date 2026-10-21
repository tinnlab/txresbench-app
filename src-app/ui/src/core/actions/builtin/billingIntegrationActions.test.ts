// TEST-12 [covers: ITEM-10] — the #60 Billing-integration mutations are permissioned,
// AI-drivable `defineAction`s (never a human-only handler): updateIntegration is
// mutating + dangerous (a payment-credential rotate); testIntegrationConnection is
// mutating. Both gate on billing::admin. The card wires them via runAction.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import "./billingIntegrationActions"; // register
import { getActionMeta, getActionRegistry } from "../defineAction";

const CARD = "src/modules/billing/components/BillingIntegrationCard.tsx";

describe("TEST-12 — billing integration actions", () => {
	it("billing.updateIntegration is registered mutating + dangerous with billing::admin", () => {
		const meta = getActionMeta("billing.updateIntegration");
		expect(meta, "billing.updateIntegration not registered").toBeTruthy();
		expect(meta?.permission).toBe("billing::admin");
		expect(meta?.mutating).toBe(true);
		expect(meta?.dangerous).toBe(true);
		expect(meta?.surfaces?.ai).not.toBe(false);
	});

	it("billing.testIntegrationConnection is registered mutating with billing::admin", () => {
		const meta = getActionMeta("billing.testIntegrationConnection");
		expect(
			meta,
			"billing.testIntegrationConnection not registered",
		).toBeTruthy();
		expect(meta?.permission).toBe("billing::admin");
		expect(meta?.mutating).toBe(true);
	});

	it("updateIntegration accepts optional secret + prices params (blank ⇒ unchanged)", () => {
		const schema = getActionRegistry().get("billing.updateIntegration")?.params;
		expect(schema, "params schema present").toBeTruthy();
		expect(schema!.safeParse({}).success).toBe(true); // price-only / no-op valid
		expect(schema!.safeParse({ stripe_secret: "sk_live_x" }).success).toBe(
			true,
		);
		expect(
			schema!.safeParse({ prices: { STRIPE_PRICE_PRO_BASE: "price_1" } })
				.success,
		).toBe(true);
		expect(schema!.safeParse({ prices: { k: 5 } }).success).toBe(false); // price ids are strings
	});

	it("the card dispatches both actions via runAction (not an inline handler)", () => {
		const src = readFileSync(resolve(process.cwd(), CARD), "utf8");
		expect(src).toContain('runAction("billing.updateIntegration"');
		expect(src).toContain('runAction("billing.testIntegrationConnection"');
	});
});
