import { useState } from "react";
import { Alert, Button, Card, Dialog, Progress, Tag, type TagTone } from "@ziee/kit";
import type {
	AbandonMigrationResponse,
	MigrationStatusView,
	RetireSourceResponse,
} from "@/api-client-saas/types";

/** Human-format a byte count (mirrors `MigrateDataCard`'s local formatter). */
function fmtBytes(n: number): string {
	if (n <= 0) return "0 B";
	const u = ["B", "KiB", "MiB", "GiB", "TiB"];
	const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
	return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** The lifecycle badge for the live-cutover view. `cutover` overrides the raw phase. */
function cutoverTag(m: MigrationStatusView): { tone: TagTone; label: string } {
	if (m.cutover) return { tone: "success", label: "Cut over live" };
	switch (m.phase) {
		case "pending":
			return m.awaiting_cost_ack
				? { tone: "warning", label: "Awaiting cost ack" }
				: { tone: "info", label: "Starting" };
		case "copying":
			return { tone: "info", label: "Copying" };
		case "verifying":
			return { tone: "info", label: "Verifying" };
		case "verified":
			return { tone: "success", label: "Verified — cutting over" };
		case "failed":
			return { tone: "error", label: "Failed — staying on the old store" };
		case "retired":
			return { tone: "default", label: "Old store retired" };
		case "abandoned":
			return { tone: "default", label: "Reverted to the old store" };
		default:
			return { tone: "default", label: "No migration" };
	}
}

export interface LiveCutoverStatusViewProps {
	/** The masked migration status (no credential). `null`/`phase==="none"` ⇒ nothing to show. */
	migration: MigrationStatusView | null;
	canManage: boolean;
	busy: boolean;
	/** The last retire-readiness result, rendered inline once checked. */
	retireResult: RetireSourceResponse | null;
	/** Acknowledge the egress cost and start the parked copy. */
	onAckCost: () => void;
	/** Run the (non-destructive) retire-source readiness check. */
	onCheckRetire: () => void;
	/** Abandon the migration and revert the primary to the OLD store (#65). Confirmed first. */
	onAbandon: () => void;
	/** The last abandon result, rendered inline once done. */
	abandonResult: AbandonMigrationResponse | null;
}

/**
 * The #64 LIVE object-store hot-cutover status/progress view — presentational, props-driven
 * (mirrors the billing `*View` split) so it renders populated in the gallery at desktop AND
 * 390px with no store/permission coupling.
 *
 * It surfaces the live-cutover lifecycle a config switch or a manual migration goes through —
 * (parked → copying/verifying with live N/M-blob + byte progress) → verified → **cut over live**
 * — distinguishing an `auto_started` config-switch cutover from a manual one. It gates a large
 * cross-cloud move behind an egress-cost acknowledgement, and once the handle is cut over live it
 * explains the OLD store is retained as the read fallback and is NOT auto-deleted, with a
 * non-destructive "safe to retire?" readiness check. Every mutation is a permissioned
 * `defineAction` dispatched by the container.
 */
export function LiveCutoverStatusView({
	migration,
	canManage,
	busy,
	retireResult,
	onAckCost,
	onCheckRetire,
	onAbandon,
	abandonResult,
}: LiveCutoverStatusViewProps) {
	const [confirmAbandon, setConfirmAbandon] = useState(false);
	// Nothing to surface until a migration exists in a cutover-relevant state.
	if (!migration || migration.phase === "none") return null;

	const m = migration;
	const tag = cutoverTag(m);
	const inFlight = m.phase === "copying" || m.phase === "verifying";
	const pct = m.blobs_total > 0 ? Math.round((m.blobs_done / m.blobs_total) * 100) : 0;
	const noPermReason = !canManage ? "You do not have permission to manage this migration" : undefined;

	return (
		<Card data-testid="infra-live-cutover-card" title="Live object-store cutover">
			<div className="flex flex-col gap-4">
				<p className="text-sm text-muted-foreground">
					When you switch the object-store backend, existing data is copied and content-verified into
					the new store and the live handle is cut over with no restart. Reads keep falling back to the
					old store until you retire it — nothing is ever deleted automatically.
				</p>

				<div className="flex flex-wrap items-center gap-3">
					<Tag tone={tag.tone} data-testid="infra-cutover-phase">
						{tag.label}
					</Tag>
					{m.auto_started && (
						<Tag tone="default" data-testid="infra-cutover-auto">
							Automatic (config switch)
						</Tag>
					)}
					{(inFlight || m.phase === "verified" || m.cutover) && (
						<span className="text-sm text-muted-foreground" data-testid="infra-cutover-counts">
							{m.blobs_done}/{m.blobs_total} blobs · {fmtBytes(m.bytes_done)} / {fmtBytes(m.bytes_total)}
						</span>
					)}
				</div>

				{/* Live copy/verify progress — a real %, N/M and phase, never a bare spinner. */}
				{inFlight && (
					<div className="flex flex-col gap-1">
						<Progress
							value={pct}
							data-testid="infra-cutover-progress"
							aria-label="Live cutover progress"
							format={(p) => `${p}%`}
						/>
						<span className="text-xs text-muted-foreground">
							{m.auto_started
								? "Switching the object store and cutting over live automatically."
								: "Copying and verifying every blob before the live cutover."}
						</span>
					</div>
				)}

				{/* Cost-ack: a large cross-cloud move is parked until the egress cost is acknowledged. */}
				{m.awaiting_cost_ack && (
					<div className="flex flex-col gap-2">
						<Alert
							data-testid="infra-cutover-cost-ack"
							tone="warning"
							title="Confirm the egress cost to start this cross-cloud move"
							description={`This ${m.src_backend} → ${m.dst_backend} move copies ${m.blobs_total} blob(s) (${fmtBytes(
								m.bytes_total,
							)}) and will bill egress on the source cloud. The copy is parked until you acknowledge the cost.`}
						/>
						<div>
							<Button
								data-testid="infra-cutover-cost-ack-btn"
								className="w-full whitespace-normal sm:w-auto"
								loading={busy}
								unavailableReason={noPermReason}
								onClick={onAckCost}
							>
								Acknowledge egress cost &amp; start migration
							</Button>
						</div>
					</div>
				)}

				{/* Failure — the live handle never switched; the old store is untouched. */}
				{m.phase === "failed" && (
					<Alert
						data-testid="infra-cutover-failed"
						tone="error"
						title="Cutover halted — still serving from the old store"
						description={`${
							m.verify_error ? `Reason: ${m.verify_error}. ` : ""
						}No cutover happened; your data is still on the old store. Fix the destination and try again.`}
					/>
				)}

				{/* Cut over live — the new store is serving; the old one is the retained read fallback. */}
				{m.cutover && (
					<div className="flex flex-col gap-2">
						<Alert
							data-testid="infra-cutover-live"
							tone="success"
							title={
								m.auto_started
									? "Cut over live automatically — now serving from the new store"
									: "Cut over live — now serving from the new store"
							}
							description={`Every blob is verified in ${m.dst_provider ?? m.dst_backend}${
								m.dst_bucket ? ` (${m.dst_bucket})` : ""
							} and the live handle was swapped with no restart. Reads still fall back to the old store.`}
						/>
						<Alert
							data-testid="infra-cutover-old-store-note"
							tone="info"
							title="Old store still present — retire it manually when ready"
							description="The old store is retained as the read fallback and is NEVER deleted automatically. When you're confident the new store is healthy, run the readiness check below, then delete the old bucket / data directory yourself."
						/>
						<div>
							<Button
								data-testid="infra-cutover-retire-check"
								variant="outline"
								className="w-full whitespace-normal sm:w-auto"
								loading={busy}
								unavailableReason={noPermReason}
								onClick={onCheckRetire}
							>
								Check whether the old store is safe to retire
							</Button>
						</div>
						{retireResult && (
							<Alert
								data-testid="infra-cutover-retire-result"
								tone={retireResult.safe_to_retire ? "success" : "warning"}
								title={
									retireResult.safe_to_retire
										? `Safe to retire — ${retireResult.verified_blobs} blob(s) verified in the new store`
										: "Not yet safe to retire"
								}
								description={retireResult.message}
							/>
						)}

						{/* #65 — Cancel / revert: put the primary back on the OLD store (next to Retire). */}
						<div>
							<Button
								data-testid="infra-cutover-abandon"
								variant="destructive"
								className="w-full whitespace-normal sm:w-auto"
								loading={busy}
								unavailableReason={noPermReason}
								onClick={() => setConfirmAbandon(true)}
							>
								Cancel / revert migration
							</Button>
						</div>
						<Dialog
							open={confirmAbandon}
							onOpenChange={setConfirmAbandon}
							title="Revert to the old object store?"
							description="This atomically switches the live primary back to the old store (no restart). The new store's copy is left in place and nothing is deleted. You can reconfigure the object store afterwards."
							data-testid="infra-cutover-abandon-dialog"
							footer={
								<>
									<Button
										variant="outline"
										data-testid="infra-cutover-abandon-cancel"
										onClick={() => setConfirmAbandon(false)}
									>
										Keep migration
									</Button>
									<Button
										variant="destructive"
										data-testid="infra-cutover-abandon-confirm"
										loading={busy}
										onClick={() => {
											setConfirmAbandon(false);
											onAbandon();
										}}
									>
										Revert to the old store
									</Button>
								</>
							}
						/>
					</div>
				)}

				{/* #65 — the abandon result (renders after the revert, when the cutover block is gone). */}
				{abandonResult?.abandoned && (
					<Alert
						data-testid="infra-cutover-abandon-result"
						tone="success"
						title={`Reverted to the ${abandonResult.reverted_to} store`}
						description={abandonResult.message}
					/>
				)}
			</div>
		</Card>
	);
}
