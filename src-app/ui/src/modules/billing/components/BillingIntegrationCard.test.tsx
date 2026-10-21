// @vitest-environment jsdom
// TEST-13 [covers: ITEM-9, ITEM-10] — the Billing-integration card renders the MASKED
// secret (never plaintext), the connection status as a badge, and reveals an EMPTY
// password input on Rotate (a stored secret is never echoed into an editable field).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	view: {
		configured: true,
		last4: "4242",
		webhook_configured: true,
		connected: "database",
		prices: { STRIPE_PRICE_PRO_BASE: "price_x" },
	} as Record<string, unknown> | null,
	saving: false,
	testing: false,
	testResult: null as { ok: boolean; message: string } | null,
	$: { error: null as string | null },
}));

vi.mock("@/modules/billing/stores/BillingIntegration.store", () => ({
	BillingIntegration: store,
}));
vi.mock("@/core/permissions", () => ({ useHasPermission: () => true }));
vi.mock("@/core/actions/defineAction", () => ({
	runAction: vi.fn().mockResolvedValue(true),
}));

import { BillingIntegrationCard } from "./BillingIntegrationCard";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as never;
});
afterEach(cleanup);

describe("TEST-13 — BillingIntegrationCard", () => {
	it("renders the masked secret + a connection badge, never the plaintext", () => {
		render(<BillingIntegrationCard />);
		// Masked fragment only — no full key anywhere in the DOM.
		expect(
			screen.getByTestId("billing-integration-masked").textContent,
		).toContain("4242");
		expect(screen.getByTestId("billing-integration-status")).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/sk_(live|test)_/);
	});

	it("Rotate reveals an EMPTY password input (a stored secret is never pre-filled)", () => {
		render(<BillingIntegrationCard />);
		// No secret input until Rotate is clicked.
		expect(screen.queryByTestId("billing-integration-secret-input")).toBeNull();
		fireEvent.click(screen.getByTestId("billing-integration-rotate"));
		const input = screen.getByTestId(
			"billing-integration-secret-input",
		) as HTMLInputElement;
		expect(input).toBeTruthy();
		// It is a password field and is EMPTY (no stored value echoed in).
		expect(input.getAttribute("type")).toBe("password");
		expect(input.value).toBe("");
	});

	it("renders the price-ID editor fields (typed, not a raw-JSON textarea)", () => {
		render(<BillingIntegrationCard />);
		expect(
			screen.getByTestId("billing-integration-price-STRIPE_PRICE_PRO_BASE"),
		).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: /json/i })).toBeNull();
	});
});
