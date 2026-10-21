import { z } from "zod";
// The SAAS permission enum — carries `billing::admin` (absent from the default
// `@/api-client/permissions`). collect-actions validates each action's permission
// VALUE against the UNION of both generated enums (#50), so these live in the single
// committed manifest and are AI-drivable on the hosted build.
import { Permissions } from "@/api-client-saas/permissions";
import { defineAction } from "../defineAction";
import { BillingIntegration } from "@/modules/billing/stores/BillingIntegration.store";

// The admin Billing-integration mutations (#60) — declared ONCE as permissioned
// `defineAction`s so they are EQUALLY drivable by a human (form button / ⌘K) and the
// AI agent, never a bare inline onClick (admin-console-shell.md §non-negotiables;
// `.claude/skills/ai-controllable-actions`). Each `run` is a THIN wrapper over the
// SAME store method the card calls. SECURITY: a secret param is passed straight to the
// API and never persisted client-side; the store only ever holds the masked view.
//
// Sole runtime import site: `src/modules/billing/module.tsx` (presence-gated).

defineAction({
	id: "billing.updateIntegration",
	title: "Update the Stripe integration config (rotate secret / prices)",
	permission: Permissions.BillingAdmin,
	mutating: true,
	// Rotating a payment credential is a dangerous write — a wrong/blank value can break
	// live billing. A blank secret means "leave unchanged" (never a silent wipe).
	dangerous: true,
	surfaces: { palette: true, ai: true },
	group: "Admin",
	description:
		"Set/rotate the Stripe secret and/or webhook signing secret (stored ENCRYPTED at " +
		"rest) and the price-ID mapping. A blank/absent secret field leaves the stored " +
		"secret unchanged. Never returns the plaintext.",
	params: z.object({
		stripe_secret: z
			.string()
			.optional()
			.describe(
				"A NEW Stripe secret key to store (encrypted). Blank/absent ⇒ unchanged.",
			),
		webhook_secret: z
			.string()
			.optional()
			.describe(
				"A NEW Stripe webhook signing secret to store. Blank/absent ⇒ unchanged.",
			),
		prices: z
			.record(z.string(), z.string())
			.optional()
			.describe(
				"Replacement Stripe price-ID map, keyed by the catalog price env-name.",
			),
	}),
	run: async (update) => BillingIntegration.save(update),
});

defineAction({
	id: "billing.testIntegrationConnection",
	title: "Test the Stripe connection",
	permission: Permissions.BillingAdmin,
	mutating: true, // makes an outbound Stripe call; not a pure read of local state
	surfaces: { palette: true, ai: true },
	group: "Admin",
	description:
		"Validate the stored (or a just-typed, un-persisted) Stripe secret with one " +
		"lightweight Stripe call. Returns {ok,message} — never the key.",
	params: z.object({
		stripe_secret: z
			.string()
			.optional()
			.describe(
				"A candidate key to test WITHOUT storing. Absent ⇒ test the stored/env key.",
			),
	}),
	run: async ({ stripe_secret }) => BillingIntegration.test(stripe_secret),
});
