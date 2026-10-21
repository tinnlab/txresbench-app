// @vitest-environment jsdom
// TEST-U3 [covers: ITEM-12] — the Migrate-data card renders its phase state + the destination
// start form (idle) and, in the verified phase, the retire-readiness controls. Positive render
// coverage for the saas-only surface the (saas-OFF) e2e harness cannot mount.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	migration: null as Record<string, unknown> | null,
	migrationBusy: false,
	loadMigration: vi.fn(),
	$: { error: null as string | null },
}));

vi.mock("@/modules/infra/stores/InfraSettings.store", () => ({ InfraSettings: store }));
vi.mock("@/core/permissions", () => ({ useHasPermission: () => true }));
vi.mock("@/core/actions/defineAction", () => ({ runAction: vi.fn().mockResolvedValue({}) }));

import { MigrateDataCard } from "./MigrateDataCard";

beforeAll(() => {
	// ResizeObserver shim (kit components use it).
	globalThis.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as never;
});
afterEach(cleanup);

describe("TEST-U3 — MigrateDataCard", () => {
	it("renders the idle phase + the destination start form when no migration exists", () => {
		store.migration = null;
		render(<MigrateDataCard />);
		expect(screen.getByTestId("infra-migrate-data-card")).toBeTruthy();
		expect(screen.getByTestId("infra-migration-phase")).toBeTruthy();
		// The destination form + Start button are shown when there is no active/verified migration.
		expect(screen.getByTestId("infra-migration-bucket")).toBeTruthy();
		expect(screen.getByTestId("infra-migration-start")).toBeTruthy();
		// No retire control while idle.
		expect(screen.queryByTestId("infra-migration-retire")).toBeNull();
	});

	it("shows progress + the retire-readiness control in the verified phase (form hidden)", () => {
		store.migration = {
			active: false,
			phase: "verified",
			blobs_total: 10,
			blobs_done: 10,
			bytes_total: 100,
			bytes_done: 100,
			cross_cloud: false,
			cost_ack: false,
		};
		render(<MigrateDataCard />);
		expect(screen.getByTestId("infra-migration-progress")).toBeTruthy();
		expect(screen.getByTestId("infra-migration-retire")).toBeTruthy();
		// The start form is hidden while a verified migration awaits retire.
		expect(screen.queryByTestId("infra-migration-start")).toBeNull();
	});
});
