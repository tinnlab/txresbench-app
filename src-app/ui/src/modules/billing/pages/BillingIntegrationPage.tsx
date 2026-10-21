import { ErrorState, Spin } from "@ziee/kit";
import { SettingsPageContainer } from "@ziee/shell";
import { useHasPermission } from "@/core/permissions";
import { BillingIntegration } from "@/modules/billing/stores/BillingIntegration.store";
import { BillingIntegrationCard } from "@/modules/billing/components/BillingIntegrationCard";

const SUBTITLE =
	"Configure the Stripe API secret (stored encrypted at rest), the webhook signing " +
	"secret, and the plan → price-ID mapping. Secrets are shown masked and never returned.";

/**
 * Admin "Billing integration" page (#60) — deployment-level Stripe credential config.
 * saas-only: the route + slot are presence-gated on `billing::admin` (absent in an
 * OSS/desktop build). Self-guards on `useHasPermission('billing::admin')` as defense in
 * depth so a restricted user who reaches the route gets an in-place 403 while their own
 * `/settings` still loads (the A10 positive control). Mirrors ProvenanceSettingsPage.
 */
export default function BillingIntegrationPage() {
	const hasAdmin = useHasPermission("billing::admin");
	const { view, loading, error } = BillingIntegration;

	if (!hasAdmin) {
		return (
			<SettingsPageContainer title="Billing integration" subtitle={SUBTITLE}>
				<ErrorState
					variant="page"
					data-testid="billing-integration-forbidden"
					resource="Billing integration"
					description="You do not have permission to view the Stripe integration settings."
				/>
			</SettingsPageContainer>
		);
	}

	if (loading && !view) {
		return (
			<SettingsPageContainer title="Billing integration" subtitle={SUBTITLE}>
				<div className="flex justify-center py-12">
					<Spin size="lg" label="Loading billing integration" />
				</div>
			</SettingsPageContainer>
		);
	}

	return (
		<SettingsPageContainer title="Billing integration" subtitle={SUBTITLE}>
			<div
				data-testid="billing-integration-page"
				className="flex flex-col gap-4"
			>
				{error && !view ? (
					<ErrorState
						variant="page"
						resource="billing integration"
						description="The billing integration settings couldn't be loaded. Check your connection and try again."
						details={error}
						onRetry={() => void BillingIntegration.load()}
						data-testid="billing-integration-error"
					/>
				) : (
					<BillingIntegrationCard />
				)}
			</div>
		</SettingsPageContainer>
	);
}
