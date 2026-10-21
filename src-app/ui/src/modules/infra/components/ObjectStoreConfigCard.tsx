import { useEffect, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Input,
	PasswordInput,
	Select,
	type SelectOption,
	Tag,
	type TagTone,
	message,
} from "@ziee/kit";
import { useHasPermission } from "@/core/permissions";
import { InfraSettings } from "@/modules/infra/stores/InfraSettings.store";
import { runAction } from "@/core/actions/defineAction";

const BACKEND_OPTIONS: SelectOption[] = [
	{ value: "local", label: "Local filesystem" },
	{ value: "s3", label: "S3 / GCS (cloud)" },
];
const PROVIDER_OPTIONS: SelectOption[] = [
	{ value: "s3", label: "Amazon S3 (or S3-compatible)" },
	{ value: "gcs", label: "Google Cloud Storage" },
];
const PATH_STYLE_OPTIONS: SelectOption[] = [
	{ value: "false", label: "Virtual-hosted (real AWS)" },
	{ value: "true", label: "Path-style (MinIO / R2)" },
];

function statusTag(status: string): { tone: TagTone; label: string } {
	switch (status) {
		case "database":
			return { tone: "success", label: "Configured (encrypted in database)" };
		case "environment":
			return { tone: "warning", label: "Using AWS_* env vars" };
		default:
			return { tone: "default", label: "Not configured (ambient identity / local)" };
	}
}

/**
 * The admin object-store backend config card (#63). Shows the effective backend +
 * masked access-key (`•••• last4`), a status badge, the non-secret connection config
 * (backend/provider/endpoint/bucket/region/path-style), Rotate controls for the two
 * credentials (empty password fields — a stored secret is NEVER echoed), and a
 * Test-connection action (a put/get/delete round-trip). Every mutation goes through a
 * permissioned `defineAction` (`runAction`), never a bare inline call.
 */
export function ObjectStoreConfigCard() {
	const { objectStore: view, compute, savingObjectStore: saving, testingObjectStore: testing, objectStoreTestResult: testResult } =
		InfraSettings;
	const canManage = useHasPermission("infra::settings::manage");

	const [backend, setBackend] = useState("local");
	const [provider, setProvider] = useState("s3");
	const [endpoint, setEndpoint] = useState("");
	const [bucket, setBucket] = useState("");
	const [region, setRegion] = useState("");
	const [pathStyle, setPathStyle] = useState("false");

	const [rotatingAccess, setRotatingAccess] = useState(false);
	const [newAccess, setNewAccess] = useState("");
	const [rotatingSecret, setRotatingSecret] = useState(false);
	const [newSecret, setNewSecret] = useState("");

	useEffect(() => {
		if (!view) return;
		setBackend(view.backend || "local");
		setProvider(view.provider || "s3");
		setEndpoint(view.endpoint || "");
		setBucket(view.bucket || "");
		setRegion(view.region || "");
		setPathStyle(view.path_style ? "true" : "false");
	}, [view]);

	const status = statusTag(view?.status ?? "unconfigured");
	const isCloud = backend === "s3";

	const saveConfig = async () => {
		const ok = await runAction("infra.updateObjectStore", {
			backend,
			provider,
			endpoint,
			bucket,
			region,
			path_style: pathStyle === "true",
		});
		if (ok) message.success("Object-store configuration saved");
		else message.error(InfraSettings.$.error ?? "Failed to save the configuration");
	};

	const saveAccessKey = async () => {
		if (!newAccess.trim()) {
			message.error("Enter a new access key to save");
			return;
		}
		const ok = await runAction("infra.updateObjectStore", { access_key_id: newAccess });
		if (ok) {
			message.success("Access key updated");
			setNewAccess("");
			setRotatingAccess(false);
		} else {
			message.error(InfraSettings.$.error ?? "Failed to update the access key");
		}
	};

	const saveSecretKey = async () => {
		if (!newSecret.trim()) {
			message.error("Enter a new secret key to save");
			return;
		}
		const ok = await runAction("infra.updateObjectStore", { secret_access_key: newSecret });
		if (ok) {
			message.success("Secret key updated");
			setNewSecret("");
			setRotatingSecret(false);
		} else {
			message.error(InfraSettings.$.error ?? "Failed to update the secret key");
		}
	};

	const testConnection = async () => {
		// Test the just-typed candidates when rotating, else the stored/env config.
		await runAction("infra.testObjectStore", {
			access_key_id: rotatingAccess && newAccess.trim() ? newAccess : undefined,
			secret_access_key: rotatingSecret && newSecret.trim() ? newSecret : undefined,
		});
	};

	// #61 §1 reciprocal coupling guard (INV-1): choosing the LOCAL store while compute is
	// remote (kubernetes) strands the cluster pods — block the save (the server also refuses
	// it 422 INCOMPATIBLE_BACKENDS).
	const computeIsRemote = (compute?.backend ?? "local") === "kubernetes";
	const couplingInvalid = backend === "local" && computeIsRemote;
	const unavailableReason = !canManage
		? "You do not have permission to change these settings"
		: undefined;
	// The coupling block applies ONLY to SAVING an incompatible pair — rotating a credential or
	// testing the connection stays available.
	const saveUnavailableReason = unavailableReason
		? unavailableReason
		: couplingInvalid
			? "Kubernetes compute is selected — it needs a remote object store, so the local store cannot be used. Choose a cloud (S3/GCS) backend, or switch compute to local first."
			: undefined;

	return (
		<Card title="Object store (cloud storage)" data-testid="infra-object-store-card">
			<div className="flex flex-col gap-4">
				{!canManage && (
					<Alert
						data-testid="infra-object-store-readonly-alert"
						tone="info"
						title="Read-only view"
						description="You can view the object-store config but not change it."
					/>
				)}

				<div className="flex flex-wrap items-center gap-2">
					<Tag tone={status.tone} data-testid="infra-object-store-status">
						{status.label}
					</Tag>
					{view?.access_key_configured && view.access_key_last4 && (
						<span data-testid="infra-object-store-masked" className="font-mono text-sm">
							access key •••• {view.access_key_last4}
						</span>
					)}
				</div>

				{couplingInvalid && (
					<Alert
						data-testid="infra-object-store-coupling-warning"
						tone="error"
						title="Incompatible: Kubernetes compute needs a remote object store"
						description="The compute backend is set to Kubernetes, whose cluster pods cannot read a local-filesystem store. Choose a cloud (S3/GCS) backend here, or switch compute to local first. Saving is blocked until then (the server also refuses this pairing)."
					/>
				)}

				{/* Non-secret connection config */}
				<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
					<span className="w-full text-sm sm:w-48">Storage backend</span>
					<Select
						data-testid="infra-object-store-backend"
						className="w-full"
						options={BACKEND_OPTIONS}
						value={backend}
						onChange={setBackend}
						placeholder="Choose a backend"
						disabled={!canManage}
					/>
				</label>

				{isCloud && (
					<>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Cloud provider</span>
							<Select
								data-testid="infra-object-store-provider"
								className="w-full"
								options={PROVIDER_OPTIONS}
								value={provider}
								onChange={setProvider}
								disabled={!canManage}
							/>
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Endpoint (optional)</span>
							<Input
								data-testid="infra-object-store-endpoint"
								className="w-full"
								placeholder="https://s3.amazonaws.com or a MinIO/R2 URL"
								value={endpoint}
								disabled={!canManage}
								onChange={(e) => setEndpoint(e.target.value)}
							/>
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Bucket</span>
							<Input
								data-testid="infra-object-store-bucket"
								className="w-full"
								placeholder="my-bucket"
								value={bucket}
								disabled={!canManage}
								onChange={(e) => setBucket(e.target.value)}
							/>
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Region</span>
							<Input
								data-testid="infra-object-store-region"
								className="w-full"
								placeholder="us-east-1"
								value={region}
								disabled={!canManage}
								onChange={(e) => setRegion(e.target.value)}
							/>
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Addressing</span>
							<Select
								data-testid="infra-object-store-path-style"
								className="w-full"
								options={PATH_STYLE_OPTIONS}
								value={pathStyle}
								onChange={setPathStyle}
								disabled={!canManage}
							/>
						</label>
					</>
				)}

				<p className="text-sm text-muted-foreground">
					The running data plane picks up a new object-store backend on the next server
					restart; use <span className="font-medium">Test connection</span> to validate the
					config live before restarting.
				</p>
				<div>
					<Button
						data-testid="infra-object-store-save"
						loading={saving}
						unavailableReason={saveUnavailableReason}
						onClick={saveConfig}
					>
						Save configuration
					</Button>
				</div>

				{/* Credentials (encrypted at rest) */}
				{isCloud && (
					<div className="flex flex-col gap-3">
						<p className="text-sm text-muted-foreground">
							Credentials are stored encrypted. Leave blank to use ambient cloud identity
							(IRSA / Workload Identity) or the AWS_* environment variables.
						</p>
						{!rotatingAccess ? (
							<div>
								<Button
									data-testid="infra-object-store-access-rotate"
									unavailableReason={unavailableReason}
									onClick={() => setRotatingAccess(true)}
								>
									{view?.access_key_configured ? "Rotate access key" : "Set access key"}
								</Button>
							</div>
						) : (
							<div className="flex flex-col gap-2">
								<PasswordInput
									data-testid="infra-object-store-access-input"
									placeholder="Enter a new access key id (e.g. AKIA…)"
									showLabel="Show"
									hideLabel="Hide"
									value={newAccess}
									onChange={(e) => setNewAccess(e.target.value)}
								/>
								<div className="flex gap-2">
									<Button
										data-testid="infra-object-store-access-save"
										loading={saving}
										unavailableReason={unavailableReason}
										onClick={saveAccessKey}
									>
										Save access key
									</Button>
									<Button
										data-testid="infra-object-store-access-cancel"
										onClick={() => {
											setRotatingAccess(false);
											setNewAccess("");
										}}
									>
										Cancel
									</Button>
								</div>
							</div>
						)}

						{!rotatingSecret ? (
							<div>
								<Button
									data-testid="infra-object-store-secret-rotate"
									unavailableReason={unavailableReason}
									onClick={() => setRotatingSecret(true)}
								>
									{view?.secret_key_configured ? "Rotate secret key" : "Set secret key"}
								</Button>
							</div>
						) : (
							<div className="flex flex-col gap-2">
								<PasswordInput
									data-testid="infra-object-store-secret-input"
									placeholder="Enter a new secret access key"
									showLabel="Show"
									hideLabel="Hide"
									value={newSecret}
									onChange={(e) => setNewSecret(e.target.value)}
								/>
								<div className="flex gap-2">
									<Button
										data-testid="infra-object-store-secret-save"
										loading={saving}
										unavailableReason={unavailableReason}
										onClick={saveSecretKey}
									>
										Save secret key
									</Button>
									<Button
										data-testid="infra-object-store-secret-cancel"
										onClick={() => {
											setRotatingSecret(false);
											setNewSecret("");
										}}
									>
										Cancel
									</Button>
								</div>
							</div>
						)}
					</div>
				)}

				{/* Test connection */}
				<div className="flex flex-col gap-2">
					<Button
						data-testid="infra-object-store-test"
						loading={testing}
						unavailableReason={unavailableReason}
						onClick={testConnection}
					>
						Test connection
					</Button>
					{testResult && (
						<Tag
							tone={testResult.ok ? "success" : "error"}
							data-testid="infra-object-store-test-result"
						>
							{testResult.message}
						</Tag>
					)}
				</div>
			</div>
		</Card>
	);
}
