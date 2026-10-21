import { useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Checkbox,
	Confirm,
	Input,
	PasswordInput,
	Progress,
	Select,
	type SelectOption,
	Tag,
	type TagTone,
	message,
} from "@ziee/kit";
import { useHasPermission } from "@/core/permissions";
import { InfraSettings } from "@/modules/infra/stores/InfraSettings.store";
import { runAction } from "@/core/actions/defineAction";

const PROVIDER_OPTIONS: SelectOption[] = [
	{ value: "s3", label: "Amazon S3 (or S3-compatible)" },
	{ value: "gcs", label: "Google Cloud Storage" },
];
const PATH_STYLE_OPTIONS: SelectOption[] = [
	{ value: "false", label: "Virtual-hosted (real AWS)" },
	{ value: "true", label: "Path-style (MinIO / R2)" },
];

function phaseTag(phase: string): { tone: TagTone; label: string } {
	switch (phase) {
		case "copying":
			return { tone: "info", label: "Copying" };
		case "verifying":
			return { tone: "info", label: "Verifying" };
		case "verified":
			return { tone: "success", label: "Verified — safe to cut over" };
		case "failed":
			return { tone: "error", label: "Failed — staying on the old store" };
		case "retired":
			return { tone: "default", label: "Old store retired" };
		default:
			return { tone: "default", label: "No migration" };
	}
}

function fmtBytes(n: number): string {
	if (n <= 0) return "0 B";
	const u = ["B", "KiB", "MiB", "GiB", "TiB"];
	const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
	return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/**
 * The "Migrate data" card (#61 §2/§3). Moves object-store blobs to a new store with COPY →
 * content-hash VERIFY → (explicit) cut over → (explicit, confirmed) retire. It never deletes
 * the source until the operator confirms retirement, and only after every blob re-verifies in
 * the destination. Shows live progress (N/M blobs + bytes + phase + verify state), gates a
 * large cross-cloud move behind an egress-cost acknowledgement, and puts the retire step
 * behind a `Confirm`. Every mutation goes through a permissioned `defineAction`.
 */
export function MigrateDataCard() {
	const { migration, migrationBusy: busy } = InfraSettings;
	const canManage = useHasPermission("infra::settings::manage");

	// The destination form (creds live ONLY in local state, passed straight to the action).
	const [provider, setProvider] = useState("s3");
	const [endpoint, setEndpoint] = useState("");
	const [bucket, setBucket] = useState("");
	const [region, setRegion] = useState("us-east-1");
	const [pathStyle, setPathStyle] = useState(false);
	const [accessKey, setAccessKey] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [costAck, setCostAck] = useState(false);
	const [confirmRetire, setConfirmRetire] = useState(false);
	// A pending cost-gate: the last start returned "cost_ack_required" with an estimate.
	const [costGate, setCostGate] = useState<{ blobs: number; bytes: number } | null>(null);

	const active = migration?.active ?? false;
	const phase = migration?.phase ?? "none";
	const tag = phaseTag(phase);

	// Poll while a migration is in flight so the progress + verify state stay live.
	useEffect(() => {
		if (phase !== "copying" && phase !== "verifying") return;
		const t = setInterval(() => void InfraSettings.loadMigration(), 2000);
		return () => clearInterval(t);
	}, [phase]);

	const dest = useMemo(
		() => ({
			provider,
			endpoint: endpoint || undefined,
			bucket: bucket || undefined,
			region: region || undefined,
			path_style: pathStyle,
			access_key_id: accessKey || undefined,
			secret_access_key: secretKey || undefined,
		}),
		[provider, endpoint, bucket, region, pathStyle, accessKey, secretKey],
	);

	const pct =
		migration && migration.blobs_total > 0
			? Math.round((migration.blobs_done / migration.blobs_total) * 100)
			: 0;

	const unavailableReason = !canManage
		? "You do not have permission to run a migration"
		: !bucket
			? "Enter the destination bucket first"
			: undefined;

	const start = async (withAck: boolean) => {
		const res = await runAction("infra.startMigration", { dest, cost_ack: withAck });
		const r = res as { started?: boolean; cost_ack_required?: boolean; estimated_blobs?: number; estimated_bytes?: number } | null;
		if (r?.cost_ack_required) {
			setCostGate({ blobs: r.estimated_blobs ?? 0, bytes: r.estimated_bytes ?? 0 });
			message.warning("This is a large cross-cloud move — review the egress cost and confirm to proceed.");
			return;
		}
		if (r?.started) {
			setCostGate(null);
			message.success("Migration started — copying and verifying blobs.");
			void InfraSettings.loadMigration();
		} else {
			message.error(InfraSettings.$.error ?? "Failed to start the migration");
		}
	};

	const retire = async () => {
		const res = await runAction("infra.retireSourceStore", { confirm: true, dest });
		const r = res as { safe_to_retire?: boolean; verified_blobs?: number; message?: string } | null;
		if (r?.safe_to_retire)
			message.success(
				r.message ?? `Verified ${r.verified_blobs ?? 0} blob(s) — the old store is safe to retire manually.`,
			);
		else message.error(InfraSettings.$.error ?? "The old store is not yet safe to retire — the preconditions are not met.");
	};

	return (
		<Card data-testid="infra-migrate-data-card" title="Migrate data">
			<div className="flex flex-col gap-4">
				<p className="text-sm text-muted-foreground">
					Move existing object-store data to a new backend. Every blob is copied under its
					content-addressed key and verified by content hash before anything is cut over. The old
					store is never deleted until you explicitly retire it, and only after a full re-verify.
				</p>

				<div className="flex flex-wrap items-center gap-3">
					<Tag tone={tag.tone} data-testid="infra-migration-phase">
						{tag.label}
					</Tag>
					{migration && (phase === "copying" || phase === "verifying" || phase === "verified") && (
						<span className="text-sm text-muted-foreground" data-testid="infra-migration-counts">
							{migration.blobs_done}/{migration.blobs_total} blobs · {fmtBytes(migration.bytes_done)} / {fmtBytes(migration.bytes_total)}
						</span>
					)}
				</div>

				{migration && (phase === "copying" || phase === "verifying" || phase === "verified") && (
					<Progress value={pct} data-testid="infra-migration-progress" aria-label="Migration progress" format={(p) => `${p}%`} />
				)}

				{phase === "failed" && migration?.verify_error && (
					<Alert
						data-testid="infra-migration-failed"
						tone="error"
						title="Migration halted — the old store is unchanged"
						description={`Reason: ${migration.verify_error}. No cutover happened; your data is still on the old store. Fix the destination and start again.`}
					/>
				)}

				{/* The cost-gate: a large cross-cloud move needs an explicit go-ahead. */}
				{costGate && (
					<Alert
						data-testid="infra-migration-cost-gate"
						tone="warning"
						title="Confirm the egress cost"
						description={`This cross-cloud move copies ${costGate.blobs} blobs (${fmtBytes(costGate.bytes)}) and will bill egress on the source cloud. Confirm to proceed.`}
					/>
				)}
				{costGate && (
					<label className="flex items-center gap-2 text-sm">
						<Checkbox
							data-testid="infra-migration-cost-ack"
							checked={costAck}
							onCheckedChange={(c: boolean) => setCostAck(c)}
							aria-label="I understand the egress cost"
						/>
						I understand this will incur cross-cloud egress charges.
					</label>
				)}

				{/* The destination form (hidden while a migration is running OR verified-awaiting-retire). */}
				{!active && phase !== "verified" && (
					<div className="flex flex-col gap-3">
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Destination provider</span>
							<Select data-testid="infra-migration-provider" className="w-full" options={PROVIDER_OPTIONS} value={provider} onChange={setProvider} disabled={!canManage} />
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Endpoint (optional)</span>
							<Input data-testid="infra-migration-endpoint" className="w-full" placeholder="https://s3.us-east-1.amazonaws.com" value={endpoint} disabled={!canManage} onChange={(e) => setEndpoint(e.target.value)} />
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Bucket</span>
							<Input data-testid="infra-migration-bucket" className="w-full" placeholder="cyto-worklab" value={bucket} disabled={!canManage} onChange={(e) => setBucket(e.target.value)} />
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Region</span>
							<Input data-testid="infra-migration-region" className="w-full" placeholder="us-east-1" value={region} disabled={!canManage} onChange={(e) => setRegion(e.target.value)} />
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Addressing</span>
							<Select data-testid="infra-migration-path-style" className="w-full" options={PATH_STYLE_OPTIONS} value={String(pathStyle)} onChange={(v) => setPathStyle(v === "true")} disabled={!canManage} />
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Access key</span>
							<Input data-testid="infra-migration-access-key" className="w-full" placeholder="(destination access key)" value={accessKey} disabled={!canManage} onChange={(e) => setAccessKey(e.target.value)} />
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Secret key</span>
							<PasswordInput data-testid="infra-migration-secret-key" className="w-full" showLabel="Show" hideLabel="Hide" placeholder="(destination secret key)" value={secretKey} disabled={!canManage} onChange={(e) => setSecretKey(e.target.value)} />
						</label>
						<div className="flex flex-wrap gap-3">
							{!costGate ? (
								<Button data-testid="infra-migration-start" loading={busy} unavailableReason={unavailableReason} onClick={() => void start(false)}>
									Start migration
								</Button>
							) : (
								<Button data-testid="infra-migration-proceed" loading={busy} unavailableReason={!costAck ? "Acknowledge the egress cost first" : undefined} onClick={() => void start(true)}>
									Proceed with the cross-cloud move
								</Button>
							)}
						</div>
					</div>
				)}

				{/* Retire the old store — only after a verified migration, behind a Confirm. */}
				{phase === "verified" && (
					<div className="flex flex-col gap-2">
						<Alert
							data-testid="infra-migration-retire-ready"
							tone="info"
							title="Migration verified — safe to switch and retire"
							description="Every blob is copied and content-verified in the destination. Switch the object-store backend above to the destination, then confirm below to re-verify the old store is safe to retire. The app never deletes the old store automatically — after this confirms, delete the old bucket / old data directory manually."
						/>
						<div>
							<Button
								data-testid="infra-migration-retire"
								loading={busy}
								unavailableReason={!canManage ? "You do not have permission" : undefined}
								onClick={() => setConfirmRetire(true)}
							>
								Confirm the old store is safe to retire…
							</Button>
						</div>
						<Confirm
							open={confirmRetire}
							onOpenChange={setConfirmRetire}
							title="Confirm the old store is safe to retire?"
							description="This re-verifies every blob is present in the destination and that no jobs are running. It deletes nothing — you then delete the old store manually."
							okText="Verify & confirm"
							cancelText="Cancel"
							data-testid="infra-migration-retire-confirm"
							onConfirm={() => {
								void retire();
								setConfirmRetire(false);
							}}
						>
							{/* native-control-ok: Base UI's AlertDialogTrigger requires a native button; this hidden anchor drives the controlled Confirm (same pattern as ProjectCard). */}
							<button type="button" aria-hidden className="hidden" data-testid="infra-migration-retire-anchor" />
						</Confirm>
					</div>
				)}
			</div>
		</Card>
	);
}
