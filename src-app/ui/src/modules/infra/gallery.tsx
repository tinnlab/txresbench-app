import { lazy } from "react";
import type { ReactElement, ReactNode } from "react";
import type { ModuleGallery } from "@ziee/gallery";
import { SettingsPageContainer } from "@ziee/shell";
import type {
	AbandonMigrationResponse,
	MigrationStatusView,
	RetireSourceResponse,
} from "@/api-client-saas/types";
import { LiveCutoverStatusView } from "@/modules/infra/components/LiveCutoverStatusView";

/**
 * Gallery seed for the #64 LIVE object-store hot-cutover status/progress view. Reviews the
 * props-driven `LiveCutoverStatusView` DIRECTLY with realistic seeded migration states — parked
 * awaiting cost-ack, an in-flight AUTOMATIC (config-switch) copy, a manual verify, and the
 * cut-over-live state (auto + manual, the latter with a retire-readiness result). The 390px
 * narrow-viewport state is applied by the shared theme/viewport matrix.
 */
const noop = () => {};

/** A fully-populated masked status; each story overrides the fields under review. */
const base: MigrationStatusView = {
	active: true,
	auto_started: false,
	awaiting_cost_ack: false,
	blobs_done: 0,
	blobs_total: 4820,
	bytes_done: 0,
	bytes_total: 96_500_000_000,
	cost_ack: false,
	cross_cloud: true,
	cutover: false,
	dst_backend: "s3",
	dst_bucket: "cyto-worklab-gcs",
	dst_provider: "gcs",
	id: "00000000-0000-4000-8000-0000000000e1",
	phase: "copying",
	src_backend: "s3",
};

function Frame({ children }: { children: ReactNode }) {
	return (
		<SettingsPageContainer title="Infrastructure" subtitle="Live-cutover status (gallery preview).">
			<div className="flex flex-col gap-4">{children}</div>
		</SettingsPageContainer>
	);
}

const Story =
	(
		migration: MigrationStatusView,
		retireResult: RetireSourceResponse | null = null,
		abandonResult: AbandonMigrationResponse | null = null,
	) =>
	() => (
		<Frame>
			<LiveCutoverStatusView
				migration={migration}
				canManage
				busy={false}
				retireResult={retireResult}
				onAckCost={noop}
				onCheckRetire={noop}
				onAbandon={noop}
				abandonResult={abandonResult}
			/>
		</Frame>
	);

const AwaitingCostAck = Story({
	...base,
	auto_started: true,
	phase: "pending",
	awaiting_cost_ack: true,
	blobs_done: 0,
	bytes_done: 0,
});

const CopyingAuto = Story({
	...base,
	auto_started: true,
	phase: "copying",
	cost_ack: true,
	blobs_done: 1930,
	bytes_done: 38_600_000_000,
});

const VerifyingManual = Story({
	...base,
	auto_started: false,
	phase: "verifying",
	cost_ack: true,
	blobs_done: 4820,
	bytes_done: 96_500_000_000,
});

const CutOverLiveAuto = Story({
	...base,
	auto_started: true,
	phase: "verified",
	cost_ack: true,
	cutover: true,
	blobs_done: 4820,
	bytes_done: 96_500_000_000,
});

const CutOverLiveManualRetireReady = Story(
	{
		...base,
		auto_started: false,
		phase: "verified",
		cost_ack: true,
		cutover: true,
		blobs_done: 4820,
		bytes_done: 96_500_000_000,
	},
	{ safe_to_retire: true, verified_blobs: 4820, message: "Every blob re-verified in the new store and no jobs are running." },
);

// #65 — the reverted (abandoned) result: the primary was put back on the old store; the new store's
// copy is left in place. The abandon-result Alert renders regardless of the (now closed) phase.
const AbandonedReverted = Story(
	{
		...base,
		auto_started: true,
		phase: "abandoned",
		cost_ack: true,
		cutover: false,
		blobs_done: 4820,
		bytes_done: 96_500_000_000,
	},
	null,
	{
		abandoned: true,
		reverted_to: "local",
		config_reverted: true,
		message:
			"Reverted to the old store. The new store's copy is left in place and nothing was deleted. You can reconfigure the object store now.",
	},
);

const asLazy = (C: () => ReactNode) => lazy(async () => ({ default: C as () => ReactElement }));

export const gallery: ModuleGallery = {
	seeded: [
		{
			slug: "infra-cutover-awaiting-cost-ack",
			title: "Live cutover — parked awaiting egress-cost ack",
			note: "A large cross-cloud (S3 → GCS) config switch parked until the operator acknowledges the egress cost.",
			path: "/gallery/infra-cutover",
			initialPath: "/gallery/infra-cutover",
			component: asLazy(AwaitingCostAck),
		},
		{
			slug: "infra-cutover-copying-auto",
			title: "Live cutover — automatic copy in flight",
			note: "An auto-started (config-switch) migration copying blobs with live N/M + byte progress.",
			path: "/gallery/infra-cutover",
			initialPath: "/gallery/infra-cutover",
			component: asLazy(CopyingAuto),
		},
		{
			slug: "infra-cutover-verifying-manual",
			title: "Live cutover — manual verify in flight",
			note: "A manually-started migration content-verifying every blob before the live cutover.",
			path: "/gallery/infra-cutover",
			initialPath: "/gallery/infra-cutover",
			component: asLazy(VerifyingManual),
		},
		{
			slug: "infra-cutover-live-auto",
			title: "Live cutover — cut over live (automatic)",
			note: "The config-switch cutover applied with no restart; old store retained as the read fallback.",
			path: "/gallery/infra-cutover",
			initialPath: "/gallery/infra-cutover",
			component: asLazy(CutOverLiveAuto),
		},
		{
			slug: "infra-cutover-live-retire-ready",
			title: "Live cutover — cut over live + retire readiness",
			note: "Cut over live with a completed readiness check confirming the old store is safe to retire manually.",
			path: "/gallery/infra-cutover",
			initialPath: "/gallery/infra-cutover",
			component: asLazy(CutOverLiveManualRetireReady),
		},
		{
			slug: "infra-cutover-abandoned",
			title: "Live cutover — reverted to the old store (#65)",
			note: "The operator abandoned the verified migration; the primary is back on the old store and the new store's copy is left in place (nothing deleted).",
			path: "/gallery/infra-cutover",
			initialPath: "/gallery/infra-cutover",
			component: asLazy(AbandonedReverted),
		},
	],
};
