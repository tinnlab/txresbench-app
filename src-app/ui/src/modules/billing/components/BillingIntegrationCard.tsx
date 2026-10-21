import { useEffect, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Input,
	PasswordInput,
	Tag,
	type TagTone,
	message,
} from "@ziee/kit";
import { useHasPermission } from "@/core/permissions";
import { BillingIntegration } from "@/modules/billing/stores/BillingIntegration.store";
import { runAction } from "@/core/actions/defineAction";

// The catalog's Stripe price slots (env-var keys) surfaced as typed, labeled fields
// (DEC-9 — never a raw-JSON textarea). Only the price IDENTIFIERS are editable; the
// allowances/policy stay code-defined (the COGS boundary).
const PRICE_SLOTS: { key: string; label: string }[] = [
	{ key: "STRIPE_PRICE_FREE_BASE", label: "Free — base price ID" },
	{ key: "STRIPE_PRICE_PRO_BASE", label: "Pro — base price ID" },
	{ key: "STRIPE_PRICE_PRO_COMPUTE", label: "Pro — metered compute price ID" },
	{ key: "STRIPE_PRICE_PRO_STORAGE", label: "Pro — metered storage price ID" },
];

function connectedTag(connected: string): { tone: TagTone; label: string } {
	switch (connected) {
		case "database":
			return { tone: "success", label: "Configured (encrypted in database)" };
		case "environment":
			return { tone: "warning", label: "Using STRIPE_SECRET_KEY env var" };
		default:
			return { tone: "default", label: "Not configured" };
	}
}

/**
 * The admin Billing-integration card (#60). Shows the MASKED Stripe secret
 * (`•••• last4`), a connection-status badge, the webhook state, a Rotate control (an
 * empty password field — a stored secret is NEVER echoed), a Test-connection action,
 * and a typed price-ID editor. Every mutation goes through a permissioned
 * `defineAction` (`runAction`), never a bare inline call. Read-gated on `billing::admin`.
 */
export function BillingIntegrationCard() {
	const { view, saving, testing, testResult } = BillingIntegration;
	const canManage = useHasPermission("billing::admin");

	// The typed secret lives ONLY in local state — never in the store, never pre-filled.
	const [rotating, setRotating] = useState(false);
	const [newSecret, setNewSecret] = useState("");
	const [rotatingWebhook, setRotatingWebhook] = useState(false);
	const [newWebhook, setNewWebhook] = useState("");
	const [prices, setPrices] = useState<Record<string, string>>({});

	useEffect(() => {
		if (view && view.prices && typeof view.prices === "object") {
			setPrices({ ...(view.prices as Record<string, string>) });
		}
	}, [view]);

	const status = connectedTag(view?.connected ?? "unconfigured");

	const saveSecret = async () => {
		if (!newSecret.trim()) {
			message.error("Enter a new Stripe secret to save");
			return;
		}
		const ok = await runAction("billing.updateIntegration", {
			stripe_secret: newSecret,
		});
		if (ok) {
			message.success("Stripe secret updated");
			setNewSecret("");
			setRotating(false);
		} else {
			message.error(
				BillingIntegration.$.error ?? "Failed to update the Stripe secret",
			);
		}
	};

	const saveWebhook = async () => {
		if (!newWebhook.trim()) {
			message.error("Enter a new webhook signing secret to save");
			return;
		}
		const ok = await runAction("billing.updateIntegration", {
			webhook_secret: newWebhook,
		});
		if (ok) {
			message.success("Webhook signing secret updated");
			setNewWebhook("");
			setRotatingWebhook(false);
		} else {
			message.error(
				BillingIntegration.$.error ?? "Failed to update the webhook secret",
			);
		}
	};

	const savePrices = async () => {
		const ok = await runAction("billing.updateIntegration", { prices });
		if (ok) message.success("Price mapping saved");
		else
			message.error(
				BillingIntegration.$.error ?? "Failed to save the price mapping",
			);
	};

	const testConnection = async () => {
		// Test the just-typed candidate when rotating, else the stored/env key.
		await runAction("billing.testIntegrationConnection", {
			stripe_secret: rotating && newSecret.trim() ? newSecret : undefined,
		});
	};

	return (
		<div data-testid="billing-integration-card" className="flex flex-col gap-4">
			{!canManage && (
				<Alert
					data-testid="billing-integration-readonly-alert"
					tone="info"
					title="Read-only view"
					description="You can view the Stripe integration status but not change it."
				/>
			)}

			{/* Stripe secret */}
			<Card
				title="Stripe API secret"
				data-testid="billing-integration-secret-card"
			>
				<div className="flex flex-col gap-3">
					<div className="flex flex-wrap items-center gap-2">
						<Tag tone={status.tone} data-testid="billing-integration-status">
							{status.label}
						</Tag>
						{view?.configured && view.last4 && (
							<span
								data-testid="billing-integration-masked"
								className="font-mono text-sm"
							>
								•••• {view.last4}
							</span>
						)}
					</div>

					{view?.connected === "unconfigured" && (
						<Alert
							data-testid="billing-integration-unconfigured-alert"
							tone="warning"
							title="No Stripe secret configured"
							description="Set a secret below (stored encrypted) or configure the STRIPE_SECRET_KEY env var."
						/>
					)}

					{!rotating ? (
						<div>
							<Button
								data-testid="billing-integration-rotate"
								unavailableReason={
									!canManage
										? "You do not have permission to change these settings"
										: undefined
								}
								onClick={() => setRotating(true)}
							>
								{view?.configured ? "Rotate secret" : "Set secret"}
							</Button>
						</div>
					) : (
						<div className="flex flex-col gap-2">
							<PasswordInput
								data-testid="billing-integration-secret-input"
								placeholder="Enter a new Stripe secret key (e.g. sk_live_…)"
								showLabel="Show secret"
								hideLabel="Hide secret"
								value={newSecret}
								onChange={(e) => setNewSecret(e.target.value)}
							/>
							<div className="flex gap-2">
								<Button
									data-testid="billing-integration-secret-save"
									loading={saving}
									unavailableReason={
										!canManage
											? "You do not have permission to change these settings"
											: undefined
									}
									onClick={saveSecret}
								>
									Save new secret
								</Button>
								<Button
									data-testid="billing-integration-secret-cancel"
									onClick={() => {
										setRotating(false);
										setNewSecret("");
									}}
								>
									Cancel
								</Button>
							</div>
						</div>
					)}

					<div className="flex flex-col gap-2">
						<Button
							data-testid="billing-integration-test"
							loading={testing}
							unavailableReason={
								!canManage
									? "You do not have permission to change these settings"
									: undefined
							}
							onClick={testConnection}
						>
							Test connection
						</Button>
						{testResult && (
							<Tag
								tone={testResult.ok ? "success" : "error"}
								data-testid="billing-integration-test-result"
							>
								{testResult.message}
							</Tag>
						)}
					</div>
				</div>
			</Card>

			{/* Webhook signing secret */}
			<Card
				title="Stripe webhook signing secret"
				data-testid="billing-integration-webhook-card"
			>
				<div className="flex flex-col gap-3">
					<Tag
						tone={view?.webhook_configured ? "success" : "default"}
						data-testid="billing-integration-webhook-status"
					>
						{view?.webhook_configured ? "Configured" : "Not configured"}
					</Tag>
					{!rotatingWebhook ? (
						<div>
							<Button
								data-testid="billing-integration-webhook-rotate"
								unavailableReason={
									!canManage
										? "You do not have permission to change these settings"
										: undefined
								}
								onClick={() => setRotatingWebhook(true)}
							>
								{view?.webhook_configured
									? "Rotate webhook secret"
									: "Set webhook secret"}
							</Button>
						</div>
					) : (
						<div className="flex flex-col gap-2">
							<PasswordInput
								data-testid="billing-integration-webhook-input"
								placeholder="Enter a new webhook signing secret (whsec_…)"
								showLabel="Show secret"
								hideLabel="Hide secret"
								value={newWebhook}
								onChange={(e) => setNewWebhook(e.target.value)}
							/>
							<div className="flex gap-2">
								<Button
									data-testid="billing-integration-webhook-save"
									loading={saving}
									unavailableReason={
										!canManage
											? "You do not have permission to change these settings"
											: undefined
									}
									onClick={saveWebhook}
								>
									Save webhook secret
								</Button>
								<Button
									data-testid="billing-integration-webhook-cancel"
									onClick={() => {
										setRotatingWebhook(false);
										setNewWebhook("");
									}}
								>
									Cancel
								</Button>
							</div>
						</div>
					)}
				</div>
			</Card>

			{/* Price-ID mapping (plaintext operator config) */}
			<Card
				title="Stripe price IDs"
				data-testid="billing-integration-prices-card"
			>
				<div className="flex flex-col gap-3">
					<p className="text-sm text-muted-foreground">
						Map each plan to its Stripe price ID. Leave a field blank to use the
						environment variable or the built-in default.
					</p>
					{PRICE_SLOTS.map((slot) => (
						<label
							key={slot.key}
							className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3"
						>
							<span className="w-full text-sm sm:w-64">{slot.label}</span>
							<Input
								data-testid={`billing-integration-price-${slot.key}`}
								className="w-full"
								placeholder="price_…"
								value={prices[slot.key] ?? ""}
								disabled={!canManage}
								onChange={(e) =>
									setPrices((p) => ({ ...p, [slot.key]: e.target.value }))
								}
							/>
						</label>
					))}
					<div>
						<Button
							data-testid="billing-integration-prices-save"
							loading={saving}
							unavailableReason={
								!canManage
									? "You do not have permission to change these settings"
									: undefined
							}
							onClick={savePrices}
						>
							Save price mapping
						</Button>
					</div>
				</div>
			</Card>
		</div>
	);
}
