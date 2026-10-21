// @vitest-environment jsdom
// TEST-21 [covers: ITEM-13] — the compute config card renders the MASKED token, reveals
// empty password inputs on Rotate.
// TEST-22 [covers: ITEM-14b] — the coupling warning renders IFF a remote compute backend
// is selected while the object store is Local, and is absent otherwise.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	compute: {
		backend: "kubernetes",
		cluster_endpoint: "https://k8s:6443",
		namespace: "cyto",
		worker_image: "cytoanalyst-worker:latest",
		kubeconfig_configured: true,
		token_configured: true,
		token_last4: "6789",
		status: "database",
	} as Record<string, unknown> | null,
	objectStore: { backend: "local" } as Record<string, unknown> | null,
	savingCompute: false,
	testingCompute: false,
	computeTestResult: null as { ok: boolean; message: string } | null,
	$: { error: null as string | null },
}));

vi.mock("@/modules/infra/stores/InfraSettings.store", () => ({ InfraSettings: store }));
vi.mock("@/core/permissions", () => ({ useHasPermission: () => true }));
vi.mock("@/core/actions/defineAction", () => ({
	runAction: vi.fn().mockResolvedValue(true),
}));

import { ComputeConfigCard } from "./ComputeConfigCard";
import { runAction } from "@/core/actions/defineAction";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as never;
});
afterEach(cleanup);

describe("TEST-21 — ComputeConfigCard", () => {
	it("renders the masked token, never a plaintext credential", () => {
		render(<ComputeConfigCard />);
		expect(screen.getByTestId("infra-compute-masked").textContent).toContain("6789");
		expect(screen.getByTestId("infra-compute-status")).toBeTruthy();
	});

	it("Rotate reveals EMPTY password inputs (kubeconfig + token)", () => {
		render(<ComputeConfigCard />);
		expect(screen.queryByTestId("infra-compute-kubeconfig-input")).toBeNull();
		fireEvent.click(screen.getByTestId("infra-compute-kubeconfig-rotate"));
		const kube = screen.getByTestId("infra-compute-kubeconfig-input") as HTMLInputElement;
		expect(kube.getAttribute("type")).toBe("password");
		expect(kube.value).toBe("");

		fireEvent.click(screen.getByTestId("infra-compute-token-rotate"));
		const token = screen.getByTestId("infra-compute-token-input") as HTMLInputElement;
		expect(token.getAttribute("type")).toBe("password");
		expect(token.value).toBe("");
	});
});

describe("TEST-22 — compute↔store coupling warning", () => {
	it("shows the warning when remote compute is paired with a Local object store", () => {
		store.compute = { ...(store.compute as object), backend: "kubernetes" };
		store.objectStore = { backend: "local" };
		render(<ComputeConfigCard />);
		expect(screen.getByTestId("infra-compute-coupling-warning")).toBeTruthy();
	});

	it("hides the warning when the object store is a cloud (remote) backend", () => {
		store.compute = { ...(store.compute as object), backend: "kubernetes" };
		store.objectStore = { backend: "s3" };
		render(<ComputeConfigCard />);
		expect(screen.queryByTestId("infra-compute-coupling-warning")).toBeNull();
	});

	it("hides the warning when compute is Local", () => {
		store.compute = { ...(store.compute as object), backend: "local" };
		store.objectStore = { backend: "local" };
		render(<ComputeConfigCard />);
		expect(screen.queryByTestId("infra-compute-coupling-warning")).toBeNull();
	});

	// TEST-C5 [acceptance] [invariant: INV-1] — the invalid pairing BLOCKS Save (aria-disabled,
	// no runAction fired) while leaving credential-rotate available (the block is scoped to Save,
	// not the whole card). Flip the block off and Save fires — that is what makes this a real
	// proof of the FE half of INV-1.
	it("BLOCKS Save for the invalid pairing but keeps rotate available", () => {
		(runAction as unknown as { mockClear: () => void }).mockClear();
		store.compute = { ...(store.compute as object), backend: "kubernetes" };
		store.objectStore = { backend: "local" };
		render(<ComputeConfigCard />);
		const save = screen.getByTestId("infra-compute-save");
		expect(save.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(save);
		expect(runAction).not.toHaveBeenCalled();
		// The rotate affordance is NOT blocked by the coupling guard.
		fireEvent.click(screen.getByTestId("infra-compute-kubeconfig-rotate"));
		expect(screen.getByTestId("infra-compute-kubeconfig-input")).toBeTruthy();
	});
});
