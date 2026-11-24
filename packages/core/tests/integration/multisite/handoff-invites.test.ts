import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	consumeHandoff,
	createHandoff,
	HANDOFF_TTL_MS,
	safeReturnPath,
} from "../../../src/multisite/handoff.js";
import { runControlPlaneMigrations } from "../../../src/multisite/migrations.js";
import {
	acceptOrgInvites,
	cancelOrgInvite,
	createOrganization,
	createSite,
	inviteToOrg,
	setOrgMember,
} from "../../../src/multisite/repository.js";
import { resolveEffectiveRole } from "../../../src/multisite/roles.js";
import type { ControlPlaneDatabase } from "../../../src/multisite/types.js";
import {
	createForDialect,
	type DialectTestContext,
	describeEachDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

describe("safeReturnPath", () => {
	it.each([
		["/blog/launch?x=1", "/blog/launch?x=1"],
		["//evil.example", "/"],
		["/\\evil.example", "/"],
		["https://evil.example", "/"],
		[null, "/"],
	])("maps %j to %j", (input, expected) => {
		expect(safeReturnPath(input)).toBe(expected);
	});
});

describeEachDialect("multi-site handoffs and invitations", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<ControlPlaneDatabase>;
	let orgId: string;
	let siteA: string;
	let siteB: string;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		db = ctx.db.withTables<ControlPlaneDatabase>();
		await runControlPlaneMigrations(db);
		orgId = (await createOrganization(db, { slug: "acme", name: "Acme" })).id;
		siteA = (
			await createSite(db, {
				orgId,
				slug: "a",
				name: "A",
				databaseRef: "a",
				hostnames: ["a.example"],
			})
		).id;
		siteB = (
			await createSite(db, {
				orgId,
				slug: "b",
				name: "B",
				databaseRef: "b",
				hostnames: ["b.example"],
			})
		).id;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	describe("handoff tokens", () => {
		it("redeems once, for the site it was issued for", async () => {
			const token = await createHandoff(db, { userId: "user-1", siteId: siteA });

			expect(await consumeHandoff(db, token, siteB)).toBeNull();
			const second = await createHandoff(db, { userId: "user-1", siteId: siteA });
			expect(await consumeHandoff(db, second, siteA)).toBe("user-1");
			expect(await consumeHandoff(db, second, siteA)).toBeNull();
		});

		it("rejects an expired token", async () => {
			const issuedAt = Date.UTC(2026, 0, 1);
			const token = await createHandoff(db, { userId: "user-1", siteId: siteA, now: issuedAt });
			expect(await consumeHandoff(db, token, siteA, issuedAt + HANDOFF_TTL_MS + 1)).toBeNull();
		});

		it("stores only the token's hash", async () => {
			const token = await createHandoff(db, { userId: "user-1", siteId: siteA });
			const rows = await db.selectFrom("_emdash_site_handoffs").select("token_hash").execute();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.token_hash).not.toBe(token);
		});

		it("rejects an unknown token", async () => {
			expect(await consumeHandoff(db, "not-a-token", siteA)).toBeNull();
		});
	});

	describe("organization invitations", () => {
		it("become memberships when the invited email signs in", async () => {
			await inviteToOrg(db, {
				orgId,
				email: " Ravi@Example.com ",
				role: Role.AUTHOR,
				invitedBy: "admin",
			});

			expect(await acceptOrgInvites(db, "user-ravi", "ravi@example.com")).toBe(1);
			expect(await resolveEffectiveRole(db, siteA, "user-ravi")).toBe(Role.AUTHOR);
			expect(await acceptOrgInvites(db, "user-ravi", "ravi@example.com")).toBe(0);
		});

		it("keep an existing member's role", async () => {
			await setOrgMember(db, orgId, "user-ravi", Role.EDITOR);
			await inviteToOrg(db, {
				orgId,
				email: "ravi@example.com",
				role: Role.SUBSCRIBER,
				invitedBy: null,
			});

			await acceptOrgInvites(db, "user-ravi", "ravi@example.com");
			expect(await resolveEffectiveRole(db, siteA, "user-ravi")).toBe(Role.EDITOR);
		});

		it("can be cancelled", async () => {
			await inviteToOrg(db, {
				orgId,
				email: "ravi@example.com",
				role: Role.AUTHOR,
				invitedBy: null,
			});
			await cancelOrgInvite(db, orgId, "RAVI@example.com");
			expect(await acceptOrgInvites(db, "user-ravi", "ravi@example.com")).toBe(0);
		});
	});
});
