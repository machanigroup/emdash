import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	availableRefs,
	handleAddMember,
	handleImportSiteAccounts,
	handleCreateOrg,
	handleCreateSite,
	handleGetOrg,
	handleListMySites,
	handleListOrgs,
	handleRemoveMember,
	handleSetSiteRole,
	handleUpdateMember,
	handleUpdateSite,
	type MultiSiteActor,
	type MultiSiteHandlerContext,
} from "../../../src/api/handlers/multisite.js";
import { siteMediaUrlResolver } from "../../../src/api/handlers/shared-media.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { runControlPlaneMigrations } from "../../../src/multisite/migrations.js";
import { resolveEffectiveRole } from "../../../src/multisite/roles.js";
import type { ControlPlaneDatabase } from "../../../src/multisite/types.js";
import { createStorage as createLocalStorage } from "../../../src/storage/local.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

const admin: MultiSiteActor = { id: "user-admin", role: Role.ADMIN };
const priya: MultiSiteActor = { id: "user-priya", role: Role.SUBSCRIBER };
const ravi: MultiSiteActor = { id: "user-ravi", role: Role.SUBSCRIBER };
const outsider: MultiSiteActor = { id: "user-out", role: Role.SUBSCRIBER };

function ok<T>(result: { success: boolean; data?: T; error?: unknown }): T {
	if (!result.success) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
	return result.data as T;
}

describeEachDialect("multi-site management", (dialect) => {
	let db: DialectTestContext;
	let siteDb: DialectTestContext;
	let ctx: MultiSiteHandlerContext;
	let controlPlane: Kysely<ControlPlaneDatabase>;
	let orgId: string;
	const invalidateHosts = vi.fn();

	beforeEach(async () => {
		db = await setupForDialect(dialect);
		controlPlane = db.db.withTables<ControlPlaneDatabase>();
		await runControlPlaneMigrations(controlPlane);
		for (const [id, email] of [
			[admin.id, "admin@example.com"],
			[priya.id, "priya@example.com"],
			[ravi.id, "ravi@example.com"],
			[outsider.id, "out@example.com"],
		] as const) {
			await db.db
				.insertInto("users")
				.values({ id, email, name: id, role: 10, email_verified: 1 })
				.execute();
		}
		invalidateHosts.mockReset();
		const multiSite = {
			controlPlane: { url: "control" },
			databases: {
				"brand-a": { url: "a" },
				"brand-b": { url: "b" },
				"same-as-control": { url: "control" },
			},
			adminUrl: "https://admin.example.com",
		};
		siteDb = await setupForDialect(dialect);
		ctx = {
			controlPlane,
			accounts: db.db,
			config: multiSite,
			deployment: {
				database: { entrypoint: "test", type: "sqlite", config: { url: "default" } },
				multiSite,
			},
			siteDatabase: async () => siteDb.db,
			invalidateHosts,
		};
		orgId = ok(await handleCreateOrg(ctx, admin, { slug: "acme", name: "Acme" })).id;
		ok(await handleAddMember(ctx, admin, orgId, { email: "priya@example.com", role: Role.ADMIN }));
	});

	afterEach(async () => {
		await teardownForDialect(db);
		await teardownForDialect(siteDb);
	});

	const site = (hostnames: string[], databaseRef = "brand-a", slug = "brand-a") =>
		handleCreateSite(ctx, admin, orgId, { slug, name: slug, databaseRef, hostnames });

	it("lets only deployment Admins create organizations and sites", async () => {
		expect(await handleCreateOrg(ctx, priya, { slug: "x", name: "X" })).toMatchObject({
			success: false,
			error: { code: "FORBIDDEN" },
		});
		expect(
			await handleCreateSite(ctx, priya, orgId, {
				slug: "s",
				name: "S",
				databaseRef: "brand-a",
				hostnames: ["s.example"],
			}),
		).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
		expect(
			(await handleListOrgs(ctx, admin)).success && ok(await handleListOrgs(ctx, admin)).canCreate,
		).toBe(true);
	});

	it("makes the creator of an organization its Admin", async () => {
		const detail = ok(await handleGetOrg(ctx, admin, orgId));
		expect(detail.members.map((m) => [m.email, m.role])).toEqual([
			["admin@example.com", Role.ADMIN],
			["priya@example.com", Role.ADMIN],
		]);
	});

	it("only attaches databases and storage the config lists", async () => {
		expect(await site(["a.example"], "not-configured")).toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR" },
		});
		ok(await site(["a.example"]));
		expect(invalidateHosts).toHaveBeenCalledTimes(1);
	});

	it("refuses a hostname another site or the admin host already uses", async () => {
		ok(await site(["a.example"]));
		expect(await site(["A.example"], "brand-b", "other")).toMatchObject({
			success: false,
			error: { code: "HOSTNAME_TAKEN" },
			status: 409,
		});
		expect(await site(["admin.example.com"], "brand-b", "other")).toMatchObject({
			success: false,
			error: { code: "HOSTNAME_TAKEN" },
		});
	});

	it("replaces a site's hostnames and keeps the first as primary", async () => {
		const { id } = ok(await site(["a.example"]));
		ok(await handleUpdateSite(ctx, admin, id, { hostnames: ["new.example", "www.new.example"] }));
		const detail = ok(await handleGetOrg(ctx, admin, orgId));
		expect(detail.sites[0]).toMatchObject({
			hostnames: ["new.example", "www.new.example"],
			primaryHostname: "new.example",
			url: "https://new.example",
		});
	});

	it("invites someone without an account to create one on the admin host", async () => {
		const inviteAccount = vi.fn(async () => ({ inviteUrl: "https://admin.example.com/invite" }));
		ctx.inviteAccount = inviteAccount;

		expect(
			ok(await handleAddMember(ctx, priya, orgId, { email: "New@Example.com", role: Role.AUTHOR })),
		).toEqual({ status: "invited", inviteUrl: "https://admin.example.com/invite" });
		expect(inviteAccount).toHaveBeenCalledWith("new@example.com", "Acme", priya.id);

		inviteAccount.mockClear();
		ok(await handleAddMember(ctx, priya, orgId, { email: "ravi@example.com", role: Role.AUTHOR }));
		expect(inviteAccount).not.toHaveBeenCalled();
	});

	it("adds people with an account and invites everyone else", async () => {
		expect(
			ok(
				await handleAddMember(ctx, priya, orgId, { email: "RAVI@example.com", role: Role.EDITOR }),
			),
		).toEqual({
			status: "added",
		});
		expect(
			ok(await handleAddMember(ctx, priya, orgId, { email: "new@example.com", role: Role.AUTHOR })),
		).toEqual({
			status: "invited",
		});
		expect(
			await handleAddMember(ctx, priya, orgId, { email: "ravi@example.com", role: Role.AUTHOR }),
		).toMatchObject({
			success: false,
			error: { code: "ALREADY_MEMBER" },
		});
		expect(ok(await handleGetOrg(ctx, priya, orgId)).invites.map((i) => i.email)).toEqual([
			"new@example.com",
		]);
	});

	it("lets organization Admins manage members and keeps other members out", async () => {
		ok(await handleAddMember(ctx, priya, orgId, { email: "ravi@example.com", role: Role.EDITOR }));

		expect(
			await handleAddMember(ctx, ravi, orgId, { email: "x@example.com", role: Role.ADMIN }),
		).toMatchObject({
			success: false,
			error: { code: "FORBIDDEN" },
		});
		const asEditor = ok(await handleGetOrg(ctx, ravi, orgId));
		expect(asEditor.canManageMembers).toBe(false);
		expect(asEditor.invites).toEqual([]);
		expect(await handleGetOrg(ctx, outsider, orgId)).toMatchObject({
			success: false,
			error: { code: "NOT_FOUND" },
		});
	});

	it("keeps at least one Admin in an organization", async () => {
		ok(await handleRemoveMember(ctx, admin, orgId, admin.id));
		expect(await handleUpdateMember(ctx, priya, orgId, priya.id, Role.EDITOR)).toMatchObject({
			success: false,
			error: { code: "LAST_ORG_ADMIN" },
			status: 409,
		});
		expect(await handleRemoveMember(ctx, priya, orgId, priya.id)).toMatchObject({
			success: false,
			error: { code: "LAST_ORG_ADMIN" },
		});
	});

	it("removing a member ends their access to every site in the organization", async () => {
		const { id } = ok(await site(["a.example"]));
		ok(await handleAddMember(ctx, priya, orgId, { email: "ravi@example.com", role: Role.EDITOR }));
		ok(await handleSetSiteRole(ctx, priya, id, ravi.id, Role.AUTHOR));
		expect(await resolveEffectiveRole(controlPlane, id, ravi.id)).toBe(Role.AUTHOR);

		ok(await handleRemoveMember(ctx, priya, orgId, ravi.id));
		expect(await resolveEffectiveRole(controlPlane, id, ravi.id)).toBeNull();
	});

	it("sets and clears a member's role on one site", async () => {
		const { id } = ok(await site(["a.example"]));
		ok(await handleAddMember(ctx, priya, orgId, { email: "ravi@example.com", role: Role.EDITOR }));

		ok(await handleSetSiteRole(ctx, priya, id, ravi.id, Role.CONTRIBUTOR));
		expect(await resolveEffectiveRole(controlPlane, id, ravi.id)).toBe(Role.CONTRIBUTOR);
		ok(await handleSetSiteRole(ctx, priya, id, ravi.id, null));
		expect(await resolveEffectiveRole(controlPlane, id, ravi.id)).toBe(Role.EDITOR);
	});

	it("lists the sites each person can switch to", async () => {
		ok(await site(["a.example"]));
		const off = ok(await site(["b.example"], "brand-b", "brand-b")).id;
		ok(await handleUpdateSite(ctx, admin, off, { status: "disabled" }));
		ok(await handleAddMember(ctx, priya, orgId, { email: "ravi@example.com", role: Role.EDITOR }));

		expect(
			ok(await handleListMySites(ctx, ravi)).items.map((s) => [s.name, s.role, s.url]),
		).toEqual([["brand-a", Role.EDITOR, "https://a.example"]]);
		expect(ok(await handleListMySites(ctx, admin)).items.map((s) => s.name)).toEqual(["brand-a"]);
		expect(ok(await handleListMySites(ctx, outsider)).items).toEqual([]);
	});

	it("gives each site in the switcher the logo saved in its settings", async () => {
		ok(await site(["a.example"]));
		ok(await handleAddMember(ctx, priya, orgId, { email: "ravi@example.com", role: Role.EDITOR }));
		const mediaUrls = async () =>
			siteMediaUrlResolver(
				{
					siteUrl: "https://a.example",
					storage: { entrypoint: "local", config: { baseUrl: "/_emdash/api/media/file" } },
				},
				createLocalStorage,
			);

		expect(ok(await handleListMySites(ctx, ravi, mediaUrls)).items[0]?.logoUrl).toBeNull();
		expect(ok(await handleListMySites(ctx, ravi)).items[0]).not.toHaveProperty("logoUrl");

		const media = await new MediaRepository(siteDb.db).create({
			filename: "logo.svg",
			mimeType: "image/svg+xml",
			storageKey: "logo-key.svg",
		});
		await new OptionsRepository(siteDb.db).set("site:logo", { mediaId: media.id });

		for (const actor of [ravi, admin]) {
			expect(ok(await handleListMySites(ctx, actor, mediaUrls)).items[0]?.logoUrl).toBe(
				"https://a.example/_emdash/api/media/file/logo-key.svg",
			);
		}
		expect(ok(await handleListMySites(ctx, ravi, async () => null)).items[0]?.logoUrl).toBeNull();
	});

	it("never offers or accepts the control-plane database for a site", async () => {
		expect(availableRefs(ctx.config, ctx.deployment).databases).toEqual([
			"default",
			"brand-a",
			"brand-b",
		]);
		expect(await site(["c.example"], "same-as-control", "c")).toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR" },
		});
	});

	it("imports a site's existing accounts under their ids, with their site roles", async () => {
		const { id } = ok(await site(["a.example"]));
		await siteDb.db
			.insertInto("users")
			.values([
				{
					id: "site-old-editor",
					email: "editor@brand-a.com",
					role: Role.EDITOR,
					email_verified: 1,
				},
				{ id: "site-old-admin", email: "boss@brand-a.com", role: Role.ADMIN, email_verified: 1 },
				{ id: "site-dup", email: "ravi@example.com", role: Role.AUTHOR, email_verified: 1 },
			])
			.execute();

		expect(ok(await handleImportSiteAccounts(ctx, admin, id))).toEqual({
			imported: 2,
			linked: 0,
			conflicts: ["ravi@example.com"],
		});
		expect(await resolveEffectiveRole(controlPlane, id, "site-old-editor")).toBe(Role.EDITOR);
		expect(await resolveEffectiveRole(controlPlane, id, "site-old-admin")).toBe(Role.ADMIN);
		const imported = await db.db
			.selectFrom("users")
			.select("role")
			.where("id", "=", "site-old-admin")
			.executeTakeFirstOrThrow();
		expect(imported.role).toBe(Role.SUBSCRIBER);

		expect(ok(await handleImportSiteAccounts(ctx, admin, id)).linked).toBe(2);
		expect(await handleImportSiteAccounts(ctx, priya, id)).toMatchObject({
			success: false,
			error: { code: "FORBIDDEN" },
		});
	});
});
