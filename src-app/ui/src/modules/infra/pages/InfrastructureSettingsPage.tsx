import { ErrorState, Spin } from "@ziee/kit";
import { SettingsPageContainer } from "@ziee/shell";
import { useHasPermission } from "@/core/permissions";
import { InfraSettings } from "@/modules/infra/stores/InfraSettings.store";
import { ObjectStoreConfigCard } from "@/modules/infra/components/ObjectStoreConfigCard";
import { ComputeConfigCard } from "@/modules/infra/components/ComputeConfigCard";
import { MigrateDataCard } from "@/modules/infra/components/MigrateDataCard";
import { LiveCutoverStatusCard } from "@/modules/infra/components/LiveCutoverStatusCard";

const SUBTITLE =
	"Configure and test the object-store (cloud storage) and compute backends. " +
	"Credentials are stored encrypted at rest, shown masked, and never returned. " +
	"Env vars remain the fallback when unconfigured.";

/**
 * Admin "Infrastructure" page (#63) — deployment-level object-store + compute backend
 * config. saas-only: the route + slot are presence-gated on `infra::settings::manage`
 * (absent in an OSS/desktop build). Self-guards on `useHasPermission` as defense in depth
 * so a restricted user who reaches the route gets an in-place 403 while their own
 * `/settings` still loads (the A10 positive control). Mirrors BillingIntegrationPage.
 */
export default function InfrastructureSettingsPage() {
	const hasAdmin = useHasPermission("infra::settings::manage");
	const { objectStore, compute, loading, error } = InfraSettings;

	if (!hasAdmin) {
		return (
			<SettingsPageContainer title="Infrastructure" subtitle={SUBTITLE}>
				<ErrorState
					variant="page"
					data-testid="infra-settings-forbidden"
					resource="Infrastructure"
					description="You do not have permission to view the infrastructure settings."
				/>
			</SettingsPageContainer>
		);
	}

	if (loading && !objectStore && !compute) {
		return (
			<SettingsPageContainer title="Infrastructure" subtitle={SUBTITLE}>
				<div className="flex justify-center py-12">
					<Spin size="lg" label="Loading infrastructure settings" />
				</div>
			</SettingsPageContainer>
		);
	}

	return (
		<SettingsPageContainer title="Infrastructure" subtitle={SUBTITLE}>
			<div data-testid="infra-settings-page" className="flex flex-col gap-4">
				{error && !objectStore && !compute ? (
					<ErrorState
						variant="page"
						resource="infrastructure settings"
						description="The infrastructure settings couldn't be loaded. Check your connection and try again."
						details={error}
						onRetry={() => void InfraSettings.load()}
						data-testid="infra-settings-error"
					/>
				) : (
					<>
						<ObjectStoreConfigCard />
						<ComputeConfigCard />
						<MigrateDataCard />
						<LiveCutoverStatusCard />
					</>
				)}
			</div>
		</SettingsPageContainer>
	);
}
