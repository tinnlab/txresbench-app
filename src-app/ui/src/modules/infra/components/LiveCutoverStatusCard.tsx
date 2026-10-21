import { useEffect, useState } from "react";
import { message } from "@ziee/kit";
import type {
	AbandonMigrationResponse,
	MigrationStatusView,
	RetireSourceResponse,
} from "@/api-client-saas/types";
import { useHasPermission } from "@/core/permissions";
import { InfraSettings } from "@/modules/infra/stores/InfraSettings.store";
import { runAction } from "@/core/actions/defineAction";
import { LiveCutoverStatusView } from "@/modules/infra/components/LiveCutoverStatusView";

/**
 * The #64 live object-store hot-cutover CONTAINER — wires the props-driven
 * `LiveCutoverStatusView` to the `InfraSettings` store: it reads the masked migration status,
 * polls `GET /admin/infra/migration` for live progress while a migration is in flight (mirroring
 * `MigrateDataCard`), gates on `infra::settings::manage`, and dispatches the two mutations through
 * their permissioned `defineAction`s (`runAction`) — never a bare inline call. Renders nothing
 * until a migration exists in a cutover-relevant state (the view returns `null`).
 */
export function LiveCutoverStatusCard() {
	const { migration, migrationBusy: busy } = InfraSettings;
	const canManage = useHasPermission("infra::settings::manage");
	const [retireResult, setRetireResult] = useState<RetireSourceResponse | null>(null);
	const [abandonResult, setAbandonResult] = useState<AbandonMigrationResponse | null>(null);

	const phase = migration?.phase ?? "none";

	// Poll while a migration is copying/verifying so the progress + phase stay live (mirrors
	// MigrateDataCard). The poll stops once it reaches a terminal/cut-over state.
	useEffect(() => {
		if (phase !== "copying" && phase !== "verifying") return;
		const t = setInterval(() => void InfraSettings.loadMigration(), 2000);
		return () => clearInterval(t);
	}, [phase]);

	const onAckCost = async () => {
		const res = (await runAction("infra.ackMigrationCost", {
			id: migration?.id,
		})) as MigrationStatusView | null;
		if (res) {
			message.success("Egress cost acknowledged — copying and verifying blobs.");
			void InfraSettings.loadMigration();
		} else {
			message.error(InfraSettings.$.error ?? "Failed to start the parked migration");
		}
	};

	const onCheckRetire = async () => {
		// Reuse the EXISTING retire-source readiness check (deletes nothing). Post-cutover the
		// destination is the live store — the masked status carries its provider/bucket labels.
		const res = (await runAction("infra.retireSourceStore", {
			confirm: true,
			dest: { provider: migration?.dst_provider, bucket: migration?.dst_bucket },
		})) as RetireSourceResponse | null;
		if (res) setRetireResult(res);
		else message.error(InfraSettings.$.error ?? "The retire-readiness check could not be run.");
	};

	const onAbandon = async () => {
		// The human already confirmed via the dialog; pass confirm:true explicitly (the backend
		// guard is real, and the AI path must pass its own confirm).
		const res = (await runAction("infra.abandonMigration", {
			confirm: true,
		})) as AbandonMigrationResponse | null;
		if (res?.abandoned) {
			setAbandonResult(res);
			setRetireResult(null);
			message.success("Reverted to the old store — the new store's copy is left in place.");
		} else {
			message.error(InfraSettings.$.error ?? "The migration could not be reverted.");
		}
	};

	return (
		<LiveCutoverStatusView
			migration={migration}
			canManage={canManage}
			busy={busy}
			retireResult={retireResult}
			onAckCost={() => void onAckCost()}
			onCheckRetire={() => void onCheckRetire()}
			onAbandon={() => void onAbandon()}
			abandonResult={abandonResult}
		/>
	);
}
