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
	{ value: "local", label: "Local (in-process sandbox)" },
	{ value: "kubernetes", label: "Kubernetes (remote cluster)" },
];

function statusTag(status: string): { tone: TagTone; label: string } {
	switch (status) {
		case "database":
			return { tone: "success", label: "Configured (encrypted in database)" };
		case "environment":
			return { tone: "warning", label: "Using ambient KUBECONFIG" };
		default:
			return { tone: "default", label: "Not configured (local compute)" };
	}
}

/**
 * The admin compute backend config card (#63). Shows the effective backend + masked
 * token (`•••• last4`), a status badge, the non-secret cluster config
 * (backend/cluster-endpoint/namespace/worker-image), Rotate controls for the
 * kubeconfig + cluster token (empty password fields — never echoed), and a
 * Test-connection action (reach the cluster + list nodes). Also surfaces the light-touch
 * coupling WARNING (#61 is the full guard): remote compute needs a remote object store.
 * Every mutation goes through a permissioned `defineAction`.
 */
export function ComputeConfigCard() {
	const {
		compute: view,
		objectStore,
		savingCompute: saving,
		testingCompute: testing,
		computeTestResult: testResult,
	} = InfraSettings;
	const canManage = useHasPermission("infra::settings::manage");

	const [backend, setBackend] = useState("local");
	const [clusterEndpoint, setClusterEndpoint] = useState("");
	const [namespace, setNamespace] = useState("");
	const [workerImage, setWorkerImage] = useState("");

	const [rotatingKube, setRotatingKube] = useState(false);
	const [newKube, setNewKube] = useState("");
	const [rotatingToken, setRotatingToken] = useState(false);
	const [newToken, setNewToken] = useState("");

	useEffect(() => {
		if (!view) return;
		setBackend(view.backend || "local");
		setClusterEndpoint(view.cluster_endpoint || "");
		setNamespace(view.namespace || "");
		setWorkerImage(view.worker_image || "");
	}, [view]);

	const status = statusTag(view?.status ?? "unconfigured");
	const isRemote = backend === "kubernetes";
	// #61 §1 HARD coupling guard (INV-1): a remote (kubernetes) compute backend can only reach
	// a REMOTE object store — a Local store is not visible to cluster pods. The invalid pairing is
	// remote compute + local store; the FE BLOCKS the save (the server also refuses it 422
	// INCOMPATIBLE_BACKENDS — the pure matrix in `backend_compat.rs` is the single source).
	const objectStoreIsLocal = (objectStore?.backend ?? "local") === "local";
	const couplingInvalid = isRemote && objectStoreIsLocal;

	const saveConfig = async () => {
		const ok = await runAction("infra.updateCompute", {
			backend,
			cluster_endpoint: clusterEndpoint,
			namespace,
			worker_image: workerImage,
		});
		if (ok) message.success("Compute configuration saved");
		else message.error(InfraSettings.$.error ?? "Failed to save the configuration");
	};

	const saveKube = async () => {
		if (!newKube.trim()) {
			message.error("Paste a kubeconfig to save");
			return;
		}
		const ok = await runAction("infra.updateCompute", { kubeconfig: newKube });
		if (ok) {
			message.success("Kubeconfig updated");
			setNewKube("");
			setRotatingKube(false);
		} else {
			message.error(InfraSettings.$.error ?? "Failed to update the kubeconfig");
		}
	};

	const saveToken = async () => {
		if (!newToken.trim()) {
			message.error("Enter a token to save");
			return;
		}
		const ok = await runAction("infra.updateCompute", { token: newToken });
		if (ok) {
			message.success("Cluster token updated");
			setNewToken("");
			setRotatingToken(false);
		} else {
			message.error(InfraSettings.$.error ?? "Failed to update the token");
		}
	};

	const testConnection = async () => {
		await runAction("infra.testCompute", {
			kubeconfig: rotatingKube && newKube.trim() ? newKube : undefined,
		});
	};

	const unavailableReason = !canManage
		? "You do not have permission to change these settings"
		: undefined;
	// The coupling block applies ONLY to SAVING an incompatible pair — rotating a credential
	// or testing the connection is unrelated to the pairing and stays available.
	const saveUnavailableReason = unavailableReason
		? unavailableReason
		: couplingInvalid
			? "Remote (Kubernetes) compute needs a remote object store — configure a cloud (S3/GCS) store above first."
			: undefined;

	return (
		<Card title="Compute backend" data-testid="infra-compute-card">
			<div className="flex flex-col gap-4">
				{!canManage && (
					<Alert
						data-testid="infra-compute-readonly-alert"
						tone="info"
						title="Read-only view"
						description="You can view the compute config but not change it."
					/>
				)}

				<div className="flex flex-wrap items-center gap-2">
					<Tag tone={status.tone} data-testid="infra-compute-status">
						{status.label}
					</Tag>
					{view?.token_configured && view.token_last4 && (
						<span data-testid="infra-compute-masked" className="font-mono text-sm">
							token •••• {view.token_last4}
						</span>
					)}
				</div>

				{couplingInvalid && (
					<Alert
						data-testid="infra-compute-coupling-warning"
						tone="error"
						title="Incompatible: remote compute needs a remote object store"
						description="Kubernetes compute runs in cluster pods that cannot read the local-filesystem object store — a pod fetches its inputs from the object store, which must be remotely reachable. Configure a cloud (S3/GCS) object store above first. Saving is blocked until then (the server also refuses this pairing)."
					/>
				)}

				<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
					<span className="w-full text-sm sm:w-48">Compute backend</span>
					<Select
						data-testid="infra-compute-backend"
						className="w-full"
						options={BACKEND_OPTIONS}
						value={backend}
						onChange={setBackend}
						placeholder="Choose a backend"
						disabled={!canManage}
					/>
				</label>

				{isRemote && (
					<>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Cluster endpoint</span>
							<Input
								data-testid="infra-compute-endpoint"
								className="w-full"
								placeholder="https://api.my-cluster:6443"
								value={clusterEndpoint}
								disabled={!canManage}
								onChange={(e) => setClusterEndpoint(e.target.value)}
							/>
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Namespace</span>
							<Input
								data-testid="infra-compute-namespace"
								className="w-full"
								placeholder="default"
								value={namespace}
								disabled={!canManage}
								onChange={(e) => setNamespace(e.target.value)}
							/>
						</label>
						<label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
							<span className="w-full text-sm sm:w-48">Worker image</span>
							<Input
								data-testid="infra-compute-worker-image"
								className="w-full"
								placeholder="cytoanalyst-worker:latest"
								value={workerImage}
								disabled={!canManage}
								onChange={(e) => setWorkerImage(e.target.value)}
							/>
						</label>
					</>
				)}

				<div>
					<Button
						data-testid="infra-compute-save"
						loading={saving}
						unavailableReason={saveUnavailableReason}
						onClick={saveConfig}
					>
						Save configuration
					</Button>
				</div>

				{isRemote && (
					<div className="flex flex-col gap-3">
						<p className="text-sm text-muted-foreground">
							Credentials are stored encrypted. Leave blank to use the ambient
							KUBECONFIG / in-cluster service-account token.
						</p>
						{!rotatingKube ? (
							<div>
								<Button
									data-testid="infra-compute-kubeconfig-rotate"
									unavailableReason={unavailableReason}
									onClick={() => setRotatingKube(true)}
								>
									{view?.kubeconfig_configured ? "Rotate kubeconfig" : "Set kubeconfig"}
								</Button>
							</div>
						) : (
							<div className="flex flex-col gap-2">
								<PasswordInput
									data-testid="infra-compute-kubeconfig-input"
									placeholder="Paste a kubeconfig (YAML)"
									showLabel="Show"
									hideLabel="Hide"
									value={newKube}
									onChange={(e) => setNewKube(e.target.value)}
								/>
								<div className="flex gap-2">
									<Button
										data-testid="infra-compute-kubeconfig-save"
										loading={saving}
										unavailableReason={unavailableReason}
										onClick={saveKube}
									>
										Save kubeconfig
									</Button>
									<Button
										data-testid="infra-compute-kubeconfig-cancel"
										onClick={() => {
											setRotatingKube(false);
											setNewKube("");
										}}
									>
										Cancel
									</Button>
								</div>
							</div>
						)}

						{!rotatingToken ? (
							<div>
								<Button
									data-testid="infra-compute-token-rotate"
									unavailableReason={unavailableReason}
									onClick={() => setRotatingToken(true)}
								>
									{view?.token_configured ? "Rotate cluster token" : "Set cluster token"}
								</Button>
							</div>
						) : (
							<div className="flex flex-col gap-2">
								<PasswordInput
									data-testid="infra-compute-token-input"
									placeholder="Enter a cluster bearer token"
									showLabel="Show"
									hideLabel="Hide"
									value={newToken}
									onChange={(e) => setNewToken(e.target.value)}
								/>
								<div className="flex gap-2">
									<Button
										data-testid="infra-compute-token-save"
										loading={saving}
										unavailableReason={unavailableReason}
										onClick={saveToken}
									>
										Save token
									</Button>
									<Button
										data-testid="infra-compute-token-cancel"
										onClick={() => {
											setRotatingToken(false);
											setNewToken("");
										}}
									>
										Cancel
									</Button>
								</div>
							</div>
						)}
					</div>
				)}

				<div className="flex flex-col gap-2">
					<Button
						data-testid="infra-compute-test"
						loading={testing}
						unavailableReason={unavailableReason}
						onClick={testConnection}
					>
						Test connection
					</Button>
					{testResult && (
						<Tag
							tone={testResult.ok ? "success" : "error"}
							data-testid="infra-compute-test-result"
						>
							{testResult.message}
						</Tag>
					)}
				</div>
			</div>
		</Card>
	);
}
