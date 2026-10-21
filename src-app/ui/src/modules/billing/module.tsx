import { CreditCard } from "lucide-react";
import { createModule } from "@ziee/framework";
import { isKnownPermission, type PermissionExpr } from "@/core/permissions";
import { SettingsLayoutDef } from "@/modules/settings/SettingsLayout";
import { lazyWithPreload } from "@/utils/lazyWithPreload";
import "@/modules/settings/types/SettingsSlots"; // Register settings slot types

// The saas-only permission string (NOT `Permissions.X`: the enum member does not
// exist in the default/OSS `Permissions` enum). Referenced by string per the #50
// seam (admin-console-shell.md §"The saas-gating seam").
const BILLING_ADMIN = "billing::admin";

/**
 * The `billing` module. Two responsibilities, both presence-gated on `billing::admin`
 * (absent from the OSS/desktop `Permissions` enum, so `isKnownPermission` is false and
 * NOTHING here registers — the module is inert on desktop):
 *
 *  1. The account-scoped billing `defineAction`s (#45/#46/#47) surfaced as widgets on
 *     the account-detail page.
 *  2. (#60) The deployment-level **Billing integration** admin page — the encrypted
 *     Stripe secret / webhook secret / price-mapping config — as a `settingsAdminPages`
 *     entry + route, plus its two `defineAction`s.
 *
 * The nav entry hides at the slot layer (not registered when the permission is absent),
 * the route is protected the same way + `permission`-gated, and the page self-guards via
 * `useHasPermission('billing::admin')`.
 */
const present = isKnownPermission(BILLING_ADMIN);

if (present) {
	// Side-effect imports: register the account-scoped billing actions + the #60
	// integration-config actions so both are palette/AI-drivable. Dynamic + presence-
	// gated (they import the saas `SaasApiClient`, absent on desktop).
	void import("@/core/actions/builtin/billingActions");
	void import("@/core/actions/builtin/billingIntegrationActions");
}

const BillingIntegrationPage = lazyWithPreload(
	() => import("./pages/BillingIntegrationPage"),
);

// The #60 route + nav slot, registered ONLY when the saas permission is present.
const integrationRoutes = present
	? [
			{
				path: "/settings/billing-integration",
				element: BillingIntegrationPage,
				requiresAuth: true,
				layout: SettingsLayoutDef,
				// Route-level gate: an unpermitted user cannot render the page directly.
				permission: BILLING_ADMIN as PermissionExpr,
			},
		]
	: [];

const integrationSlots = present
	? {
			settingsAdminPages: [
				{
					id: "billing-integration",
					icon: <CreditCard />,
					label: "Billing integration",
					path: "billing-integration",
					order: 45,
					permission: BILLING_ADMIN as PermissionExpr,
				},
			],
		}
	: {};

export default createModule({
	metadata: {
		name: "billing",
		version: "1.0.0",
		description:
			"Admin billing controls (subscription/plan overrides, usage & quota, credits & grants) " +
			"surfaced as widgets on the account-detail page, plus the deployment-level Billing " +
			"integration (encrypted Stripe secret) admin page.",
	},
	dependencies: ["router"],
	routes: integrationRoutes,
	stores: [],
	slots: integrationSlots,
});
