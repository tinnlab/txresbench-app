import { Server } from "lucide-react";
import { createModule } from "@ziee/framework";
import { isKnownPermission, type PermissionExpr } from "@/core/permissions";
import { SettingsLayoutDef } from "@/modules/settings/SettingsLayout";
import { lazyWithPreload } from "@/utils/lazyWithPreload";
import "@/modules/settings/types/SettingsSlots"; // Register settings slot types

// The saas-only permission string (NOT `Permissions.X`: the enum member does not exist
// in the default/OSS `Permissions` enum). Referenced by string per the #50 seam.
const INFRA_MANAGE = "infra::settings::manage";

/**
 * The `infra` module (#63) — the deployment-level Infrastructure admin page: the
 * object-store (S3/GCS) + compute (Kubernetes) backend config + test-connection, as a
 * `settingsAdminPages` entry + route, plus its four `defineAction`s.
 *
 * Presence-gated on `infra::settings::manage` (absent from the OSS/desktop `Permissions`
 * enum, so `isKnownPermission` is false and NOTHING here registers — the module is inert
 * on desktop). The nav entry hides at the slot layer, the route is `permission`-gated,
 * and the page self-guards via `useHasPermission`.
 */
const present = isKnownPermission(INFRA_MANAGE);

if (present) {
	// Side-effect import: register the infra config actions so they are palette/AI-drivable.
	// Dynamic + presence-gated (they import the saas `SaasApiClient`, absent on desktop).
	void import("@/core/actions/builtin/infrastructureActions");
}

const InfrastructureSettingsPage = lazyWithPreload(
	() => import("./pages/InfrastructureSettingsPage"),
);

const infraRoutes = present
	? [
			{
				path: "/settings/infrastructure",
				element: InfrastructureSettingsPage,
				requiresAuth: true,
				layout: SettingsLayoutDef,
				permission: INFRA_MANAGE as PermissionExpr,
			},
		]
	: [];

const infraSlots = present
	? {
			settingsAdminPages: [
				{
					id: "infrastructure",
					icon: <Server />,
					label: "Infrastructure",
					path: "infrastructure",
					order: 46,
					permission: INFRA_MANAGE as PermissionExpr,
				},
			],
		}
	: {};

export default createModule({
	metadata: {
		name: "infra",
		version: "1.0.0",
		description:
			"Deployment-level Infrastructure admin page — object-store (S3/GCS) + compute " +
			"(Kubernetes) backend config with encrypted credentials and test-connection.",
	},
	dependencies: ["router"],
	routes: infraRoutes,
	stores: [],
	slots: infraSlots,
});
