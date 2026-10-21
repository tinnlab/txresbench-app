// @vitest-environment jsdom
// TEST-20 [covers: ITEM-13] — the object-store config card renders the MASKED access key
// (never plaintext), a status badge, and reveals EMPTY password inputs on Rotate (a
// stored secret is never echoed into an editable field).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	objectStore: {
		backend: "s3",
		provider: "s3",
		endpoint: "http://minio:9000",
		bucket: "cyto-worklab",
		region: "us-east-1",
		path_style: true,
		access_key_configured: true,
		access_key_last4: "MPLE",
		secret_key_configured: true,
		status: "database",
	} as Record<string, unknown> | null,
	compute: null as Record<string, unknown> | null,
	savingObjectStore: false,
	testingObjectStore: false,
	objectStoreTestResult: null as { ok: boolean; message: string } | null,
	$: { error: null as string | null },
}));

vi.mock("@/modules/infra/stores/InfraSettings.store", () => ({ InfraSettings: store }));
vi.mock("@/core/permissions", () => ({ useHasPermission: () => true }));
vi.mock("@/core/actions/defineAction", () => ({
	runAction: vi.fn().mockResolvedValue(true),
}));

import { ObjectStoreConfigCard } from "./ObjectStoreConfigCard";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as never;
});
afterEach(cleanup);

describe("TEST-20 — ObjectStoreConfigCard", () => {
	it("renders the masked access key + a status badge, never a plaintext secret", () => {
		render(<ObjectStoreConfigCard />);
		expect(screen.getByTestId("infra-object-store-masked").textContent).toContain("MPLE");
		expect(screen.getByTestId("infra-object-store-status")).toBeTruthy();
		// No full AWS-style key or literal secret in the DOM.
		expect(document.body.textContent).not.toMatch(/AKIA[0-9A-Z]{12,}/);
	});

	it("Rotate reveals EMPTY password inputs (a stored secret is never pre-filled)", () => {
		render(<ObjectStoreConfigCard />);
		expect(screen.queryByTestId("infra-object-store-access-input")).toBeNull();
		fireEvent.click(screen.getByTestId("infra-object-store-access-rotate"));
		const access = screen.getByTestId("infra-object-store-access-input") as HTMLInputElement;
		expect(access.getAttribute("type")).toBe("password");
		expect(access.value).toBe("");

		fireEvent.click(screen.getByTestId("infra-object-store-secret-rotate"));
		const secret = screen.getByTestId("infra-object-store-secret-input") as HTMLInputElement;
		expect(secret.getAttribute("type")).toBe("password");
		expect(secret.value).toBe("");
	});
});
