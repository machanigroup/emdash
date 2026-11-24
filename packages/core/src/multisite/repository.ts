import { toRoleLevel, type RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { MultiSiteError } from "./errors.js";
import { requireHostname } from "./hosts.js";
import type { ControlPlaneDatabase, Organization, Site } from "./types.js";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function requireSlug(slug: string): string {
	if (!SLUG_PATTERN.test(slug)) {
		throw new MultiSiteError("INVALID_SLUG", `Invalid slug: ${slug}`);
	}
	return slug;
}

function requireRole(role: number): RoleLevel {
	try {
		return toRoleLevel(role);
	} catch {
		throw new MultiSiteError("INVALID_ROLE", `Invalid role level: ${role}`);
	}
}

export async function createOrganization(
	db: Kysely<ControlPlaneDatabase>,
	input: { slug: string; name: string },
): Promise<Organization> {
	const org = { id: ulid(), slug: requireSlug(input.slug), name: input.name };
	await db.insertInto("_emdash_orgs").values(org).execute();
	return org;
}

/**
 * Registers a site and its hostnames in one transaction. The first hostname is
 * the site's primary hostname.
 */
export async function createSite(
	db: Kysely<ControlPlaneDatabase>,
	input: {
		orgId: string;
		slug: string;
		name: string;
		databaseRef: string;
		storageRef?: string | null;
		hostnames: string[];
	},
): Promise<Site> {
	const hostnames = [...new Set(input.hostnames.map(requireHostname))];
	if (hostnames.length === 0) {
		throw new MultiSiteError("INVALID_HOSTNAME", "A site needs at least one hostname");
	}
	const site: Site = {
		id: ulid(),
		orgId: input.orgId,
		slug: requireSlug(input.slug),
		name: input.name,
		databaseRef: input.databaseRef,
		storageRef: input.storageRef ?? null,
		status: "active",
	};
	await db.transaction().execute(async (trx) => {
		await trx
			.insertInto("_emdash_sites")
			.values({
				id: site.id,
				org_id: site.orgId,
				slug: site.slug,
				name: site.name,
				database_ref: site.databaseRef,
				storage_ref: site.storageRef,
				status: site.status,
			})
			.execute();
		await trx
			.insertInto("_emdash_site_hosts")
			.values(
				hostnames.map((hostname, index) => ({
					hostname,
					site_id: site.id,
					is_primary: index === 0 ? 1 : 0,
				})),
			)
			.execute();
	});
	return site;
}

export async function setOrgMember(
	db: Kysely<ControlPlaneDatabase>,
	orgId: string,
	userId: string,
	role: number,
): Promise<void> {
	const level = requireRole(role);
	await db
		.insertInto("_emdash_org_members")
		.values({ org_id: orgId, user_id: userId, role: level })
		.onConflict((oc) => oc.columns(["org_id", "user_id"]).doUpdateSet({ role: level }))
		.execute();
}

/** Removes a member and the member's role overrides on the organization's sites. */
export async function removeOrgMember(
	db: Kysely<ControlPlaneDatabase>,
	orgId: string,
	userId: string,
): Promise<void> {
	await db.transaction().execute(async (trx) => {
		await trx
			.deleteFrom("_emdash_site_role_overrides")
			.where("user_id", "=", userId)
			.where(
				"site_id",
				"in",
				trx.selectFrom("_emdash_sites").select("id").where("org_id", "=", orgId),
			)
			.execute();
		await trx
			.deleteFrom("_emdash_org_members")
			.where("org_id", "=", orgId)
			.where("user_id", "=", userId)
			.execute();
	});
}

/** Gives a member of the site's organization a different role on that one site. */
export async function setSiteRoleOverride(
	db: Kysely<ControlPlaneDatabase>,
	siteId: string,
	userId: string,
	role: number,
): Promise<void> {
	const level = requireRole(role);
	const member = await db
		.selectFrom("_emdash_sites as s")
		.innerJoin("_emdash_org_members as m", (join) =>
			join.onRef("m.org_id", "=", "s.org_id").on("m.user_id", "=", userId),
		)
		.select("s.id")
		.where("s.id", "=", siteId)
		.executeTakeFirst();
	if (!member) {
		throw new MultiSiteError(
			"NOT_A_MEMBER",
			"Site role overrides need membership in the site's organization",
		);
	}
	await db
		.insertInto("_emdash_site_role_overrides")
		.values({ site_id: siteId, user_id: userId, role: level })
		.onConflict((oc) => oc.columns(["site_id", "user_id"]).doUpdateSet({ role: level }))
		.execute();
}

export async function clearSiteRoleOverride(
	db: Kysely<ControlPlaneDatabase>,
	siteId: string,
	userId: string,
): Promise<void> {
	await db
		.deleteFrom("_emdash_site_role_overrides")
		.where("site_id", "=", siteId)
		.where("user_id", "=", userId)
		.execute();
}

export async function setSiteStatus(
	db: Kysely<ControlPlaneDatabase>,
	siteId: string,
	status: Site["status"],
): Promise<void> {
	const result = await db
		.updateTable("_emdash_sites")
		.set({ status, updated_at: new Date().toISOString() })
		.where("id", "=", siteId)
		.executeTakeFirst();
	if (result.numUpdatedRows === 0n) {
		throw new MultiSiteError("NOT_FOUND", `Site not found: ${siteId}`);
	}
}

export interface AccessibleSite {
	id: string;
	slug: string;
	name: string;
	orgId: string;
	orgSlug: string;
	orgName: string;
	role: RoleLevel;
}

/** Active sites a user can reach, with the effective role on each, for the site switcher. */
export async function listSitesForUser(
	db: Kysely<ControlPlaneDatabase>,
	userId: string,
): Promise<AccessibleSite[]> {
	const rows = await db
		.selectFrom("_emdash_org_members as m")
		.innerJoin("_emdash_orgs as org", "org.id", "m.org_id")
		.innerJoin("_emdash_sites as s", "s.org_id", "m.org_id")
		.leftJoin("_emdash_site_role_overrides as o", (join) =>
			join.onRef("o.site_id", "=", "s.id").on("o.user_id", "=", userId),
		)
		.select([
			"s.id",
			"s.slug",
			"s.name",
			"org.id as org_id",
			"org.slug as org_slug",
			"org.name as org_name",
			"m.role as org_role",
			"o.role as override_role",
		])
		.where("m.user_id", "=", userId)
		.where("s.status", "=", "active")
		.orderBy("org.slug")
		.orderBy("s.slug")
		.execute();
	return rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		name: row.name,
		orgId: row.org_id,
		orgSlug: row.org_slug,
		orgName: row.org_name,
		role: toRoleLevel(row.override_role ?? row.org_role),
	}));
}
