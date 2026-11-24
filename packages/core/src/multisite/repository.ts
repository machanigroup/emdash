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

/**
 * Invites an email address to an organization. The invitation becomes a
 * membership the next time an account with that email signs in on the admin
 * host, so people can be invited before they have an account.
 */
export async function inviteToOrg(
	db: Kysely<ControlPlaneDatabase>,
	input: { orgId: string; email: string; role: number; invitedBy: string | null },
): Promise<void> {
	const role = requireRole(input.role);
	const email = input.email.trim().toLowerCase();
	await db
		.insertInto("_emdash_org_invites")
		.values({
			org_id: input.orgId,
			email,
			role,
			invited_by: input.invitedBy,
			created_at: new Date().toISOString(),
		})
		.onConflict((oc) => oc.columns(["org_id", "email"]).doUpdateSet({ role }))
		.execute();
}

export async function cancelOrgInvite(
	db: Kysely<ControlPlaneDatabase>,
	orgId: string,
	email: string,
): Promise<void> {
	await db
		.deleteFrom("_emdash_org_invites")
		.where("org_id", "=", orgId)
		.where("email", "=", email.trim().toLowerCase())
		.execute();
}

/**
 * Turns pending invitations for `email` into memberships for `userId`.
 * Returns the number of organizations joined. Existing memberships keep their
 * role.
 */
export async function acceptOrgInvites(
	db: Kysely<ControlPlaneDatabase>,
	userId: string,
	email: string,
): Promise<number> {
	const normalized = email.trim().toLowerCase();
	const invites = await db
		.selectFrom("_emdash_org_invites")
		.select(["org_id", "role"])
		.where("email", "=", normalized)
		.execute();
	if (invites.length === 0) return 0;
	await db.transaction().execute(async (trx) => {
		for (const invite of invites) {
			// oxlint-disable-next-line no-await-in-loop -- a handful of invitations, inside one transaction
			await trx
				.insertInto("_emdash_org_members")
				.values({ org_id: invite.org_id, user_id: userId, role: invite.role })
				.onConflict((oc) => oc.columns(["org_id", "user_id"]).doNothing())
				.execute();
		}
		await trx.deleteFrom("_emdash_org_invites").where("email", "=", normalized).execute();
	});
	return invites.length;
}

export interface OrganizationSummary extends Organization {
	/** The viewer's role in the organization, or null for a deployment Admin who isn't a member. */
	role: RoleLevel | null;
	siteCount: number;
	memberCount: number;
}

/**
 * Organizations with their site and member counts: every organization when
 * `memberId` is null, otherwise the ones `memberId` belongs to.
 */
export async function listOrganizations(
	db: Kysely<ControlPlaneDatabase>,
	viewerId: string,
	options: { all: boolean },
): Promise<OrganizationSummary[]> {
	let query = db
		.selectFrom("_emdash_orgs as o")
		.leftJoin("_emdash_org_members as me", (join) =>
			join.onRef("me.org_id", "=", "o.id").on("me.user_id", "=", viewerId),
		)
		.select((eb) => [
			"o.id",
			"o.slug",
			"o.name",
			"me.role",
			eb
				.selectFrom("_emdash_sites as s")
				.whereRef("s.org_id", "=", "o.id")
				.select(eb.fn.countAll<number>().as("n"))
				.as("site_count"),
			eb
				.selectFrom("_emdash_org_members as m")
				.whereRef("m.org_id", "=", "o.id")
				.select(eb.fn.countAll<number>().as("n"))
				.as("member_count"),
		])
		.orderBy("o.slug");
	if (!options.all) query = query.where("me.user_id", "is not", null);
	const rows = await query.execute();
	return rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		name: row.name,
		role: row.role === null ? null : toRoleLevel(row.role),
		siteCount: Number(row.site_count ?? 0),
		memberCount: Number(row.member_count ?? 0),
	}));
}

export async function getOrganization(
	db: Kysely<ControlPlaneDatabase>,
	orgId: string,
): Promise<Organization | null> {
	const row = await db
		.selectFrom("_emdash_orgs")
		.select(["id", "slug", "name"])
		.where("id", "=", orgId)
		.executeTakeFirst();
	return row ?? null;
}

export async function renameOrganization(
	db: Kysely<ControlPlaneDatabase>,
	orgId: string,
	name: string,
): Promise<void> {
	const result = await db
		.updateTable("_emdash_orgs")
		.set({ name, updated_at: new Date().toISOString() })
		.where("id", "=", orgId)
		.executeTakeFirst();
	if (result.numUpdatedRows === 0n) {
		throw new MultiSiteError("NOT_FOUND", `Organization not found: ${orgId}`);
	}
}

/** A member's role in an organization, or null when they aren't a member. */
export async function orgRoleFor(
	db: Kysely<ControlPlaneDatabase>,
	orgId: string,
	userId: string,
): Promise<RoleLevel | null> {
	const row = await db
		.selectFrom("_emdash_org_members")
		.select("role")
		.where("org_id", "=", orgId)
		.where("user_id", "=", userId)
		.executeTakeFirst();
	return row ? toRoleLevel(row.role) : null;
}

export interface SiteDetail extends Site {
	hostnames: string[];
	primaryHostname: string;
}

export async function getSite(
	db: Kysely<ControlPlaneDatabase>,
	siteId: string,
): Promise<SiteDetail | null> {
	const [site] = await listSitesWhere(db, { siteId });
	return site ?? null;
}

export function listOrgSites(
	db: Kysely<ControlPlaneDatabase>,
	orgId: string,
): Promise<SiteDetail[]> {
	return listSitesWhere(db, { orgId });
}

async function listSitesWhere(
	db: Kysely<ControlPlaneDatabase>,
	filter: { siteId?: string; orgId?: string },
): Promise<SiteDetail[]> {
	let query = db
		.selectFrom("_emdash_sites as s")
		.leftJoin("_emdash_site_hosts as h", "h.site_id", "s.id")
		.select([
			"s.id",
			"s.org_id",
			"s.slug",
			"s.name",
			"s.database_ref",
			"s.storage_ref",
			"s.status",
			"h.hostname",
			"h.is_primary",
		])
		.orderBy("s.slug")
		.orderBy("h.is_primary", "desc")
		.orderBy("h.hostname");
	if (filter.siteId !== undefined) query = query.where("s.id", "=", filter.siteId);
	if (filter.orgId !== undefined) query = query.where("s.org_id", "=", filter.orgId);
	const rows = await query.execute();
	const sites = new Map<string, SiteDetail>();
	for (const row of rows) {
		let site = sites.get(row.id);
		if (!site) {
			site = {
				id: row.id,
				orgId: row.org_id,
				slug: row.slug,
				name: row.name,
				databaseRef: row.database_ref,
				storageRef: row.storage_ref,
				status: row.status,
				hostnames: [],
				primaryHostname: row.hostname ?? "",
			};
			sites.set(row.id, site);
		}
		if (row.hostname) site.hostnames.push(row.hostname);
	}
	return [...sites.values()];
}

/** Changes a site's name, status, or hostnames. The first hostname becomes the primary one. */
export async function updateSite(
	db: Kysely<ControlPlaneDatabase>,
	siteId: string,
	input: { name?: string; status?: Site["status"]; hostnames?: string[] },
): Promise<void> {
	const hostnames = input.hostnames && [...new Set(input.hostnames.map(requireHostname))];
	if (hostnames && hostnames.length === 0) {
		throw new MultiSiteError("INVALID_HOSTNAME", "A site needs at least one hostname");
	}
	await db.transaction().execute(async (trx) => {
		const result = await trx
			.updateTable("_emdash_sites")
			.set({
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.status !== undefined ? { status: input.status } : {}),
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", siteId)
			.executeTakeFirst();
		if (result.numUpdatedRows === 0n) {
			throw new MultiSiteError("NOT_FOUND", `Site not found: ${siteId}`);
		}
		if (hostnames) {
			await trx.deleteFrom("_emdash_site_hosts").where("site_id", "=", siteId).execute();
			await trx
				.insertInto("_emdash_site_hosts")
				.values(
					hostnames.map((hostname, index) => ({
						hostname,
						site_id: siteId,
						is_primary: index === 0 ? 1 : 0,
					})),
				)
				.execute();
		}
	});
}

export interface OrgMember {
	userId: string;
	role: RoleLevel;
	/** Per-site roles that replace `role` on those sites. */
	siteRoles: Array<{ siteId: string; role: RoleLevel }>;
}

export async function listOrgMembers(
	db: Kysely<ControlPlaneDatabase>,
	orgId: string,
): Promise<OrgMember[]> {
	const [members, overrides] = await Promise.all([
		db
			.selectFrom("_emdash_org_members")
			.select(["user_id", "role"])
			.where("org_id", "=", orgId)
			.orderBy("created_at")
			.execute(),
		db
			.selectFrom("_emdash_site_role_overrides as o")
			.innerJoin("_emdash_sites as s", "s.id", "o.site_id")
			.select(["o.user_id", "o.site_id", "o.role"])
			.where("s.org_id", "=", orgId)
			.execute(),
	]);
	return members.map((member) => ({
		userId: member.user_id,
		role: toRoleLevel(member.role),
		siteRoles: overrides
			.filter((override) => override.user_id === member.user_id)
			.map((override) => ({ siteId: override.site_id, role: toRoleLevel(override.role) })),
	}));
}

export async function listOrgInvites(
	db: Kysely<ControlPlaneDatabase>,
	orgId: string,
): Promise<Array<{ email: string; role: RoleLevel; createdAt: string }>> {
	const rows = await db
		.selectFrom("_emdash_org_invites")
		.select(["email", "role", "created_at"])
		.where("org_id", "=", orgId)
		.orderBy("created_at")
		.execute();
	return rows.map((row) => ({
		email: row.email,
		role: toRoleLevel(row.role),
		createdAt: row.created_at,
	}));
}

export async function countOrgAdmins(
	db: Kysely<ControlPlaneDatabase>,
	orgId: string,
): Promise<number> {
	const row = await db
		.selectFrom("_emdash_org_members")
		.select((eb) => eb.fn.countAll<number>().as("n"))
		.where("org_id", "=", orgId)
		.where("role", ">=", 50)
		.executeTakeFirstOrThrow();
	return Number(row.n);
}
