import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import {
	type ControlPlaneUser,
	ensureSiteSetUp,
	findControlPlaneUser,
	refreshSiteAccount,
	siteRoleFor,
	syncSiteUser,
} from "../../../src/multisite/identity.js";
import { runControlPlaneMigrations } from "../../../src/multisite/migrations.js";
import {
	createOrganization,
	createSite,
	removeOrgMember,
	setOrgMember,
} from "../../../src/multisite/repository.js";
import type { ControlPlaneDatabase } from "../../../src/multisite/types.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

const ravi: ControlPlaneUser = {
	id: "user-ravi",
	email: "ravi@example.com",
	name: "Ravi",
	avatarUrl: null,
	role: Role.SUBSCRIBER,
	emailVerified: true,
	disabled: false,
};

describeEachDialect("multi-site identity", (dialect) => {
	let control: DialectTestContext;
	let site: DialectTestContext;
	let controlPlane: Kysely<ControlPlaneDatabase>;
	let siteId: string;

	beforeEach(async () => {
		control = await setupForDialect(dialect);
		site = await setupForDialect(dialect);
		controlPlane = control.db.withTables<ControlPlaneDatabase>();
		await runControlPlaneMigrations(controlPlane);
		const org = await createOrganization(controlPlane, { slug: "acme", name: "Acme" });
		siteId = (
			await createSite(controlPlane, {
				orgId: org.id,
				slug: "brand-a",
				name: "Brand A",
				databaseRef: "brand-a",
				hostnames: ["brand-a.com"],
			})
		).id;
		await control.db
			.insertInto("users")
			.values({
				id: ravi.id,
				email: ravi.email,
				name: ravi.name,
				role: ravi.role,
				email_verified: 1,
			})
			.execute();
	});

	afterEach(async () => {
		await teardownForDialect(control);
		await teardownForDialect(site);
	});

	const siteUser = (db: Kysely<Database>, id: string) =>
		db
			.selectFrom("users")
			.select(["email", "name", "role", "disabled", "updated_at"])
			.where("id", "=", id)
			.executeTakeFirst();

	it("reads the signed-in account from the control plane", async () => {
		expect(await findControlPlaneUser(control.db, ravi.id)).toEqual(ravi);
		expect(await findControlPlaneUser(control.db, "missing")).toBeNull();
	});

	it("gives deployment Admins Admin on every site and members their organization role", async () => {
		expect(await siteRoleFor(controlPlane, { ...ravi, role: Role.ADMIN }, siteId)).toBe(Role.ADMIN);
		expect(await siteRoleFor(controlPlane, ravi, siteId)).toBeNull();

		const [org] = await controlPlane.selectFrom("_emdash_orgs").select("id").execute();
		await setOrgMember(controlPlane, org!.id, ravi.id, Role.EDITOR);
		expect(await siteRoleFor(controlPlane, ravi, siteId)).toBe(Role.EDITOR);
		expect(await siteRoleFor(controlPlane, { ...ravi, disabled: true }, siteId)).toBeNull();
	});

	it("copies the account into the site with the site role and keeps it current", async () => {
		await syncSiteUser(site.db, ravi, Role.EDITOR);
		expect(await siteUser(site.db, ravi.id)).toMatchObject({
			email: ravi.email,
			name: "Ravi",
			role: Role.EDITOR,
			disabled: 0,
		});

		await syncSiteUser(site.db, { ...ravi, name: "Ravi K" }, Role.AUTHOR);
		expect(await siteUser(site.db, ravi.id)).toMatchObject({ name: "Ravi K", role: Role.AUTHOR });
	});

	it("does not write when the copy is already current", async () => {
		await syncSiteUser(site.db, ravi, Role.EDITOR);
		await site.db.updateTable("users").set({ updated_at: "marker" }).execute();

		await syncSiteUser(site.db, ravi, Role.EDITOR);
		expect((await siteUser(site.db, ravi.id))?.updated_at).toBe("marker");
	});

	it("refuses to merge with a separate site account that has the same email", async () => {
		await site.db
			.insertInto("users")
			.values({
				id: "local-user",
				email: ravi.email,
				name: "Local",
				role: Role.ADMIN,
				email_verified: 1,
			})
			.execute();

		await expect(syncSiteUser(site.db, ravi, Role.SUBSCRIBER)).rejects.toMatchObject({
			code: "ACCOUNT_CONFLICT",
		});
		expect(await siteUser(site.db, ravi.id)).toBeUndefined();
		expect((await siteUser(site.db, "local-user"))?.role).toBe(Role.ADMIN);
	});

	it("marks a new site as set up with its name as the title", async () => {
		await ensureSiteSetUp(site.db, "Brand A");
		const options = new OptionsRepository(site.db);
		expect(await options.get("emdash:setup_complete")).toBe(true);
		expect(await options.get("emdash:site_title")).toBe("Brand A");

		await options.set("emdash:site_title", "Renamed");
		await ensureSiteSetUp(site.db, "Brand A");
		expect(await options.get("emdash:site_title")).toBe("Renamed");
	});

	describe("refreshSiteAccount", () => {
		const refresh = () => refreshSiteAccount(controlPlane, control.db, site.db, siteId, ravi.id);
		const orgId = async () =>
			(await controlPlane.selectFrom("_emdash_orgs").select("id").executeTakeFirstOrThrow()).id;

		it("applies a role change made in the control plane to the site's copy", async () => {
			await setOrgMember(controlPlane, await orgId(), ravi.id, Role.EDITOR);
			await syncSiteUser(site.db, ravi, Role.EDITOR);
			await setOrgMember(controlPlane, await orgId(), ravi.id, Role.CONTRIBUTOR);

			expect(await refresh()).toBe(Role.CONTRIBUTOR);
			expect((await siteUser(site.db, ravi.id))?.role).toBe(Role.CONTRIBUTOR);
		});

		it("disables the copy of a removed member and restores it when they are added back", async () => {
			await setOrgMember(controlPlane, await orgId(), ravi.id, Role.EDITOR);
			await syncSiteUser(site.db, ravi, Role.EDITOR);

			await removeOrgMember(controlPlane, await orgId(), ravi.id);
			expect(await refresh()).toBeNull();
			expect((await siteUser(site.db, ravi.id))?.disabled).toBe(1);

			await setOrgMember(controlPlane, await orgId(), ravi.id, Role.AUTHOR);
			expect(await refresh()).toBe(Role.AUTHOR);
			expect(await siteUser(site.db, ravi.id)).toMatchObject({ disabled: 0, role: Role.AUTHOR });
		});

		it("denies an account the control plane doesn't know without changing the site", async () => {
			await site.db
				.insertInto("users")
				.values({
					id: "local-only",
					email: "local@example.com",
					role: Role.ADMIN,
					email_verified: 1,
				})
				.execute();

			expect(
				await refreshSiteAccount(controlPlane, control.db, site.db, siteId, "local-only"),
			).toBeNull();
			expect((await siteUser(site.db, "local-only"))?.disabled).toBe(0);
		});
	});
});
