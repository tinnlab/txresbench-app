// @vitest-environment jsdom
// TEST-8 [covers: ITEM-7] — the #65 "Cancel / revert migration" control on the cut-over-live card:
// it renders next to Retire, is disabled (with the no-permission reason) for a user lacking
// infra::settings::manage, opens a confirm dialog whose confirm calls onAbandon, and the
// abandon-result Alert renders once the revert is done. Props-driven — no store coupling.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MigrationStatusView } from "@/api-client-saas/types";
import { LiveCutoverStatusView } from "./LiveCutoverStatusView";

const CUT_OVER: MigrationStatusView = {
	active: false,
	auto_started: true,
	awaiting_cost_ack: false,
	blobs_done: 100,
	blobs_total: 100,
	bytes_done: 1000,
	bytes_total: 1000,
	cost_ack: true,
	cross_cloud: true,
	cutover: true,
	dst_backend: "s3",
	dst_bucket: "cyto-new",
	dst_provider: "gcs",
	id: "mig-1",
	phase: "verified",
	src_backend: "local",
};

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as never;
});
afterEach(cleanup);

const baseProps = {
	migration: CUT_OVER,
	canManage: true,
	busy: false,
	retireResult: null,
	onAckCost: vi.fn(),
	onCheckRetire: vi.fn(),
	onAbandon: vi.fn(),
	abandonResult: null,
};

describe("TEST-8 — LiveCutoverStatusView abandon control (#65)", () => {
	it("renders the revert control next to Retire in the cut-over-live state", () => {
		render(<LiveCutoverStatusView {...baseProps} />);
		expect(screen.getByTestId("infra-cutover-retire-check")).toBeTruthy();
		expect(screen.getByTestId("infra-cutover-abandon")).toBeTruthy();
	});

	it("disables the revert control (with the no-permission reason) for a user lacking the permission", () => {
		render(<LiveCutoverStatusView {...baseProps} canManage={false} />);
		const btn = screen.getByTestId("infra-cutover-abandon");
		expect(btn.getAttribute("aria-disabled")).toBe("true");
	});

	it("opens a confirm dialog and only calls onAbandon after the explicit confirm", () => {
		const onAbandon = vi.fn();
		render(<LiveCutoverStatusView {...baseProps} onAbandon={onAbandon} />);
		fireEvent.click(screen.getByTestId("infra-cutover-abandon"));
		// The confirm dialog is now open; onAbandon has NOT fired yet.
		expect(onAbandon).not.toHaveBeenCalled();
		expect(screen.getByTestId("infra-cutover-abandon-confirm")).toBeTruthy();
		fireEvent.click(screen.getByTestId("infra-cutover-abandon-confirm"));
		expect(onAbandon).toHaveBeenCalledTimes(1);
	});

	// TEST-9 [covers: ITEM-7] — the populated cut-over-live view renders the revert control ALONGSIDE
	// Retire (the "next to Retire" precedent), and the revert control does NOT render outside the
	// cutover state (a plain copying/failed migration shows no abandon control).
	it("renders the revert control next to Retire only in the cutover state", () => {
		const { rerender } = render(<LiveCutoverStatusView {...baseProps} />);
		// Populated cut-over-live: both controls present, side by side.
		expect(screen.getByTestId("infra-cutover-retire-check")).toBeTruthy();
		expect(screen.getByTestId("infra-cutover-abandon")).toBeTruthy();

		// A copying (in-flight) migration is NOT a cutover state ⇒ no revert control.
		rerender(
			<LiveCutoverStatusView
				{...baseProps}
				migration={{ ...CUT_OVER, cutover: false, phase: "copying" }}
			/>,
		);
		expect(screen.queryByTestId("infra-cutover-abandon")).toBeNull();

		// A failed migration is not a cutover state either.
		rerender(
			<LiveCutoverStatusView
				{...baseProps}
				migration={{ ...CUT_OVER, cutover: false, phase: "failed", verify_error: "io error" }}
			/>,
		);
		expect(screen.queryByTestId("infra-cutover-abandon")).toBeNull();
	});

	it("renders the abandon-result Alert once the revert is done", () => {
		render(
			<LiveCutoverStatusView
				{...baseProps}
				abandonResult={{
					abandoned: true,
					reverted_to: "local",
					config_reverted: true,
					message: "Reverted to the old store. The new store's copy is left in place and nothing was deleted.",
				}}
			/>,
		);
		const alert = screen.getByTestId("infra-cutover-abandon-result");
		expect(alert.textContent).toContain("Reverted to the local store");
		expect(alert.textContent).toContain("left in place");
	});
});
