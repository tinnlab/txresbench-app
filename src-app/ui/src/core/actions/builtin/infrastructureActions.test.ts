// TEST-24 [covers: ITEM-15] — the #63 Infrastructure config mutations are permissioned,
// AI-drivable `defineAction`s (never a human-only handler). The two update actions are
// mutating + dangerous (credential rotate / backend switch); the two test actions are
// mutating. All gate on infra::settings::manage. The cards wire them via runAction.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import "./infrastructureActions"; // register
import { getActionMeta, getActionRegistry } from "../defineAction";

const OBJECT_CARD = "src/modules/infra/components/ObjectStoreConfigCard.tsx";
const COMPUTE_CARD = "src/modules/infra/components/ComputeConfigCard.tsx";

describe("TEST-24 — infrastructure config actions", () => {
	it("all four actions register with infra::settings::manage", () => {
		for (const id of [
			"infra.updateObjectStore",
			"infra.testObjectStore",
			"infra.updateCompute",
			"infra.testCompute",
		]) {
			const meta = getActionMeta(id);
			expect(meta, `${id} not registered`).toBeTruthy();
			expect(meta?.permission).toBe("infra::settings::manage");
			expect(meta?.mutating).toBe(true);
			expect(meta?.surfaces?.ai).not.toBe(false);
		}
	});

	it("the two update actions are dangerous (credential rotate / backend switch)", () => {
		expect(getActionMeta("infra.updateObjectStore")?.dangerous).toBe(true);
		expect(getActionMeta("infra.updateCompute")?.dangerous).toBe(true);
	});

	it("updateObjectStore accepts optional fields (blank ⇒ unchanged)", () => {
		const schema = getActionRegistry().get("infra.updateObjectStore")?.params;
		expect(schema, "params schema present").toBeTruthy();
		expect(schema!.safeParse({}).success).toBe(true); // no-op valid
		expect(schema!.safeParse({ access_key_id: "AKIA_x" }).success).toBe(true);
		expect(schema!.safeParse({ backend: "s3", path_style: true }).success).toBe(true);
	});

	it("the cards dispatch every action via runAction (not an inline handler)", () => {
		const objectSrc = readFileSync(resolve(process.cwd(), OBJECT_CARD), "utf8");
		expect(objectSrc).toContain('runAction("infra.updateObjectStore"');
		expect(objectSrc).toContain('runAction("infra.testObjectStore"');
		const computeSrc = readFileSync(resolve(process.cwd(), COMPUTE_CARD), "utf8");
		expect(computeSrc).toContain('runAction("infra.updateCompute"');
		expect(computeSrc).toContain('runAction("infra.testCompute"');
	});

	// #64 — the live-cutover cost-ack mutation.
	it("infra.ackMigrationCost is a mutating, dangerous, permissioned action", () => {
		const meta = getActionMeta("infra.ackMigrationCost");
		expect(meta, "infra.ackMigrationCost not registered").toBeTruthy();
		expect(meta?.permission).toBe("infra::settings::manage");
		expect(meta?.mutating).toBe(true);
		expect(meta?.dangerous).toBe(true);
		expect(meta?.surfaces?.ai).not.toBe(false);
	});

	it("infra.ackMigrationCost accepts an optional id (newest parked ⇒ absent)", () => {
		const schema = getActionRegistry().get("infra.ackMigrationCost")?.params;
		expect(schema, "params schema present").toBeTruthy();
		expect(schema!.safeParse({}).success).toBe(true);
		expect(schema!.safeParse({ id: "mig-1" }).success).toBe(true);
		expect(schema!.safeParse({ id: 42 }).success).toBe(false);
	});

	it("the live-cutover container dispatches its mutations via runAction", () => {
		const cardSrc = readFileSync(resolve(process.cwd(), "src/modules/infra/components/LiveCutoverStatusCard.tsx"), "utf8");
		expect(cardSrc).toContain('runAction("infra.ackMigrationCost"');
		expect(cardSrc).toContain('runAction("infra.retireSourceStore"');
	});
});

// TEST-FE2 — infra.ackMigrationCost permissioned defineAction (#64 ITEM-8)

// TEST-7 [covers: ITEM-6] — the #65 abandon mutation is a mutating, DANGEROUS, permissioned action,
// AI+palette drivable, and the container dispatches it via runAction (not an inline handler).
describe("TEST-7 — infra.abandonMigration (#65)", () => {
	it("is a mutating, dangerous, infra::settings::manage action on palette+ai", () => {
		const meta = getActionMeta("infra.abandonMigration");
		expect(meta, "infra.abandonMigration not registered").toBeTruthy();
		expect(meta?.permission).toBe("infra::settings::manage");
		expect(meta?.mutating).toBe(true);
		expect(meta?.dangerous).toBe(true);
		expect(meta?.surfaces?.ai).not.toBe(false);
		expect(meta?.surfaces?.palette).not.toBe(false);
	});

	it("accepts confirm (the go-ahead flag)", () => {
		const schema = getActionRegistry().get("infra.abandonMigration")?.params;
		expect(schema, "params schema present").toBeTruthy();
		expect(schema!.safeParse({ confirm: true }).success).toBe(true);
	});

	it("the container dispatches abandon via runAction with confirm:true (guard is real)", () => {
		const cardSrc = readFileSync(resolve(process.cwd(), "src/modules/infra/components/LiveCutoverStatusCard.tsx"), "utf8");
		expect(cardSrc).toContain('runAction("infra.abandonMigration"');
		// The human path passes confirm:true explicitly — never an empty payload that the store
		// would silently force-confirm (the confirm param must be honored end-to-end).
		expect(cardSrc).toMatch(/runAction\("infra\.abandonMigration",\s*\{\s*confirm:\s*true/);
	});

	it("the abandon action's run HONORS confirm (does not hardcode true)", () => {
		const src = readFileSync(resolve(process.cwd(), "src/core/actions/builtin/infrastructureActions.ts"), "utf8");
		// run destructures confirm and forwards it — a false/omitted value must not abandon.
		expect(src).toMatch(/run:\s*async\s*\(\{\s*confirm\s*\}\)\s*=>\s*InfraSettings\.abandonMigration\(confirm/);
	});
});
