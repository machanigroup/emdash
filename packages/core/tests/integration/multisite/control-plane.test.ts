import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeHostname, SiteHostResolver } from "../../../src/multisite/hosts.js";
import { runControlPlaneMigrations } from "../../../src/multisite/migrations.js";
import {
	clearSiteRoleOverride,
	createOrganization,
	createSite,
	listSitesForUser,
	removeOrgMember,
	setOrgMember,
	setSiteRoleOverride,
	setSiteStatus,
} from "../../../src/multisite/repository.js";
import { resolveEffectiveRole } from "../../../src/multisite/roles.js";
import type { ControlPlaneDatabase, Organization, Site } from "../../../src/multisite/types.js";
import {
	createForDialect,
	type DialectTestContext,
	describeEachDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

describe("normalizeHostname", () => {
	it.each([
		["Brand-A.com", "brand-a.com"],
		["brand-a.com:4321", "brand-a.com"],
		["brand-a.com.", "brand-a.com"],
		["localhost:4321", "localhost"],
	])("normalizes %s", (input, expected) => {
		expect(normalizeHostname(input)).toBe(expected);
	});

	it.each(["", "127.0.0.1", "[::1]:4321", "bad_host.com", "-a.com", "a..com"])(
		"rejects %j",
		(input) => {
			expect(normalizeHostname(input)).toBeNull();
		},
	);
});

describeEachDialect("multi-site control plane", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<ControlPlaneDatabase>;
	let acme: Organization;
	let other: Organization;
	let brandA: Site;
	let brandB: Site;
	let otherSite: Site;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		db = ctx.db.withTables<ControlPlaneDatabase>();
		await runControlPlaneMigrations(db);
		acme = await createOrganization(db, { slug: "acme", name: "Acme" });
		other = await createOrganization(db, { slug: "other", name: "Other" });
		brandA = await createSite(db, {
			orgId: acme.id,
			slug: "brand-a",
			name: "Brand A",
			databaseRef: "DB_BRAND_A",
			storageRef: "MEDIA_BRAND_A",
			hostnames: ["brand-a.com", "www.brand-a.com"],
		});
		brandB = await createSite(db, {
			orgId: acme.id,
			slug: "brand-b",
			name: "Brand B",
			databaseRef: "DB_BRAND_B",
			hostnames: ["brand-b.com"],
		});
		otherSite = await createSite(db, {
			orgId: other.id,
			slug: "other",
			name: "Other",
			databaseRef: "DB_OTHER",
			hostnames: ["other.example"],
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("applies no migrations on a second run", async () => {
		expect(await runControlPlaneMigrations(db)).toEqual({ applied: [] });
	});

	describe("SiteHostResolver", () => {
		it("maps every registered hostname to its site", async () => {
			const resolver = new SiteHostResolver(db);
			expect(await resolver.resolve("Brand-A.com:443")).toEqual({
				siteId: brandA.id,
				orgId: acme.id,
				name: "Brand A",
				primaryHostname: "brand-a.com",
				databaseRef: "DB_BRAND_A",
				storageRef: "MEDIA_BRAND_A",
			});
			expect((await resolver.resolve("www.brand-a.com"))?.primaryHostname).toBe("brand-a.com");
			expect((await resolver.resolve("www.brand-a.com"))?.siteId).toBe(brandA.id);
			expect((await resolver.resolve("brand-b.com"))?.siteId).toBe(brandB.id);
		});

		it("resolves unknown and malformed hosts to null", async () => {
			const resolver = new SiteHostResolver(db);
			expect(await resolver.resolve("unknown.example")).toBeNull();
			expect(await resolver.resolve("127.0.0.1")).toBeNull();
			expect(await resolver.resolve(null)).toBeNull();
		});

		it("serves cached hosts until invalidated", async () => {
			const resolver = new SiteHostResolver(db);
			await resolver.resolve("brand-a.com");
			await setSiteStatus(db, brandA.id, "disabled");
			expect((await resolver.resolve("brand-a.com"))?.siteId).toBe(brandA.id);

			resolver.invalidate();
			expect(await resolver.resolve("brand-a.com")).toBeNull();
		});

		it("rejects a hostname that another site already uses", async () => {
			await expect(
				createSite(db, {
					orgId: other.id,
					slug: "takeover",
					name: "Takeover",
					databaseRef: "DB_X",
					hostnames: ["brand-a.com"],
				}),
			).rejects.toThrow();
			const resolver = new SiteHostResolver(db);
			expect((await resolver.resolve("brand-a.com"))?.siteId).toBe(brandA.id);
		});
	});

	describe("resolveEffectiveRole", () => {
		it("applies the organization role to every site in the organization", async () => {
			await setOrgMember(db, acme.id, "user-ravi", Role.EDITOR);
			expect(await resolveEffectiveRole(db, brandA.id, "user-ravi")).toBe(Role.EDITOR);
			expect(await resolveEffectiveRole(db, brandB.id, "user-ravi")).toBe(Role.EDITOR);
		});

		it("grants nothing on another organization's site", async () => {
			await setOrgMember(db, acme.id, "user-ravi", Role.ADMIN);
			expect(await resolveEffectiveRole(db, otherSite.id, "user-ravi")).toBeNull();
		});

		it("uses a site override on that site only", async () => {
			await setOrgMember(db, acme.id, "user-ravi", Role.EDITOR);
			await setSiteRoleOverride(db, brandB.id, "user-ravi", Role.AUTHOR);
			expect(await resolveEffectiveRole(db, brandA.id, "user-ravi")).toBe(Role.EDITOR);
			expect(await resolveEffectiveRole(db, brandB.id, "user-ravi")).toBe(Role.AUTHOR);

			await clearSiteRoleOverride(db, brandB.id, "user-ravi");
			expect(await resolveEffectiveRole(db, brandB.id, "user-ravi")).toBe(Role.EDITOR);
		});

		it("updates the role when membership is set again", async () => {
			await setOrgMember(db, acme.id, "user-ravi", Role.EDITOR);
			await setOrgMember(db, acme.id, "user-ravi", Role.CONTRIBUTOR);
			expect(await resolveEffectiveRole(db, brandA.id, "user-ravi")).toBe(Role.CONTRIBUTOR);
		});

		it("refuses an override for a user outside the organization", async () => {
			await setOrgMember(db, other.id, "user-ravi", Role.ADMIN);
			await expect(
				setSiteRoleOverride(db, brandA.id, "user-ravi", Role.ADMIN),
			).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
			expect(await resolveEffectiveRole(db, brandA.id, "user-ravi")).toBeNull();
		});

		it("revokes every site and override when a member is removed", async () => {
			await setOrgMember(db, acme.id, "user-ravi", Role.EDITOR);
			await setOrgMember(db, other.id, "user-ravi", Role.EDITOR);
			await setSiteRoleOverride(db, brandB.id, "user-ravi", Role.ADMIN);

			await removeOrgMember(db, acme.id, "user-ravi");

			expect(await resolveEffectiveRole(db, brandA.id, "user-ravi")).toBeNull();
			expect(await resolveEffectiveRole(db, brandB.id, "user-ravi")).toBeNull();
			expect(await resolveEffectiveRole(db, otherSite.id, "user-ravi")).toBe(Role.EDITOR);

			await setOrgMember(db, acme.id, "user-ravi", Role.AUTHOR);
			expect(await resolveEffectiveRole(db, brandB.id, "user-ravi")).toBe(Role.AUTHOR);
		});

		it("grants nothing on a disabled site", async () => {
			await setOrgMember(db, acme.id, "user-ravi", Role.ADMIN);
			await setSiteStatus(db, brandA.id, "disabled");
			expect(await resolveEffectiveRole(db, brandA.id, "user-ravi")).toBeNull();
			expect(await resolveEffectiveRole(db, brandB.id, "user-ravi")).toBe(Role.ADMIN);
		});
	});

	describe("listSitesForUser", () => {
		it("lists reachable active sites with the effective role on each", async () => {
			await setOrgMember(db, acme.id, "user-ravi", Role.EDITOR);
			await setSiteRoleOverride(db, brandB.id, "user-ravi", Role.AUTHOR);
			await setOrgMember(db, other.id, "user-ravi", Role.SUBSCRIBER);
			await setSiteStatus(db, otherSite.id, "disabled");

			const sites = await listSitesForUser(db, "user-ravi");
			expect(sites.map((site) => [site.slug, site.role])).toEqual([
				["brand-a", Role.EDITOR],
				["brand-b", Role.AUTHOR],
			]);
		});
	});

	describe("sites without a hostname", () => {
		it("can be created, found by id, and reached at no hostname", async () => {
			const site = await createSite(db, {
				orgId: acme.id,
				slug: "no-domain",
				name: "No domain yet",
				databaseRef: "DB_X",
				hostnames: [],
			});
			const resolver = new SiteHostResolver(db);

			expect(await resolver.findSite(site.id)).toMatchObject({
				siteId: site.id,
				name: "No domain yet",
				primaryHostname: null,
			});
			expect((await resolver.allSites()).map((s) => s.siteId)).toContain(site.id);
			expect(await resolver.resolve("no-domain.example")).toBeNull();
		});
	});

	describe("validation", () => {
		it("rejects invalid slugs, hostnames, and roles", async () => {
			await expect(createOrganization(db, { slug: "Bad Slug", name: "x" })).rejects.toMatchObject({
				code: "INVALID_SLUG",
			});
			await expect(
				createSite(db, {
					orgId: acme.id,
					slug: "ok",
					name: "x",
					databaseRef: "DB",
					hostnames: ["not a host"],
				}),
			).rejects.toMatchObject({ code: "INVALID_HOSTNAME" });
			await expect(setOrgMember(db, acme.id, "user-ravi", 99)).rejects.toMatchObject({
				code: "INVALID_ROLE",
			});
		});
	});
});
