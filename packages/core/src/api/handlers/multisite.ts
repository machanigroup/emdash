/**
 * Organizations, sites, and members of a multi-site deployment, managed on the
 * shared admin host. Deployment Admins (Admin in the control plane) manage
 * everything; organization Admins manage their organization's members.
 */

import {
	hasPermission,
	Role,
	toRoleLevel,
	type Permission,
	type RoleLevel,
} from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import type { EmDashConfig, MultiSiteConfig } from "../../astro/integration/runtime.js";
import {
	DEFAULT_SITE_REF,
	isControlPlaneDatabase,
	siteOrigin,
} from "../../astro/middleware/site.js";
import type { Database } from "../../database/types.js";
import { MultiSiteError } from "../../multisite/errors.js";
import { requireHostname } from "../../multisite/hosts.js";
import { importSiteAccounts, type SiteAccountImport } from "../../multisite/identity.js";
import {
	cancelOrgInvite,
	clearSiteRoleOverride,
	countOrgAdmins,
	createOrganization,
	createSite,
	getOrganization,
	getSite,
	inviteToOrg,
	listOrganizations,
	listOrgInvites,
	listOrgMembers,
	listOrgSites,
	listSitesForUser,
	orgRoleFor,
	type OrganizationSummary,
	removeOrgMember,
	renameOrganization,
	setOrgMember,
	setSiteRoleOverride,
	type SiteDetail,
	updateSite,
} from "../../multisite/repository.js";
import type { ControlPlaneDatabase } from "../../multisite/types.js";
import type { ApiResult } from "../types.js";

export interface MultiSiteHandlerContext {
	controlPlane: Kysely<ControlPlaneDatabase>;
	/** The control plane's accounts, for member names and emails. */
	accounts: Kysely<Database>;
	config: MultiSiteConfig;
	/** The whole deployment config, for the database options site names resolve to. */
	deployment: EmDashConfig;
	/** Opens an active site's database, or null when the site isn't active. */
	siteDatabase: (siteId: string) => Promise<Kysely<Database> | null>;
	/**
	 * Invites an email to create an account on the admin host, returning the
	 * link to share when no email provider is configured.
	 */
	inviteAccount?: (
		email: string,
		organizationName: string,
		invitedBy: string,
	) => Promise<{ inviteUrl?: string }>;
	/** Drops this worker's cached hostnames after a site or hostname change. */
	invalidateHosts: () => void;
}

/** The signed-in user, with their role in the control plane. */
export interface MultiSiteActor {
	id: string;
	role: RoleLevel;
}

type Failure = Extract<ApiResult<never>, { success: false }>;

function fail(code: string, message: string, status?: number): Failure {
	return { success: false, error: { code, message }, ...(status ? { status } : {}) };
}

function isDeploymentAdmin(actor: MultiSiteActor): boolean {
	return actor.role >= Role.ADMIN;
}

function fromError(error: unknown, fallback: string): Failure {
	if (error instanceof MultiSiteError) {
		switch (error.code) {
			case "NOT_FOUND":
				return fail("NOT_FOUND", error.message);
			case "NOT_A_MEMBER":
				return fail("NOT_A_MEMBER", error.message, 400);
			case "INVALID_DATABASE":
				return fail("VALIDATION_ERROR", error.message);
			default:
				return fail("VALIDATION_ERROR", error.message);
		}
	}
	console.error(`[emdash:multisite] ${fallback}:`, error);
	return fail("MULTISITE_ERROR", fallback, 500);
}

/** Null when `actor` may use `permission` in the organization, otherwise the failure to return. */
async function checkOrgPermission(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	orgId: string,
	permission: Permission,
): Promise<Failure | null> {
	const org = await getOrganization(ctx.controlPlane, orgId);
	if (!org) return fail("NOT_FOUND", "Organization not found");
	if (isDeploymentAdmin(actor)) return null;
	const role = await orgRoleFor(ctx.controlPlane, orgId, actor.id);
	if (role === null) return fail("NOT_FOUND", "Organization not found");
	if (!hasPermission({ role }, permission)) return fail("FORBIDDEN", "Insufficient permissions");
	return null;
}

function requireDeploymentPermission(
	actor: MultiSiteActor,
	permission: Permission,
): Failure | null {
	return hasPermission(actor, permission) ? null : fail("FORBIDDEN", "Insufficient permissions");
}

function siteUrl(ctx: MultiSiteHandlerContext, hostname: string): string {
	return siteOrigin(hostname, ctx.config.adminUrl);
}

/**
 * Names that a site's `databaseRef` and `storageRef` may use. A database
 * that is also the control-plane database is left out.
 */
export function availableRefs(
	config: MultiSiteConfig,
	deployment: EmDashConfig,
): { databases: string[]; storages: string[] } {
	return {
		databases: [DEFAULT_SITE_REF, ...Object.keys(config.databases)].filter(
			(ref) => !isControlPlaneDatabase(deployment, ref),
		),
		storages: [DEFAULT_SITE_REF, ...Object.keys(config.storages ?? {})],
	};
}

export interface SiteSwitcherItem {
	id: string;
	name: string;
	orgId: string;
	orgName: string;
	role: RoleLevel;
	url: string;
}

/** The sites the user can manage, for the admin's site switcher. */
export async function handleListMySites(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
): Promise<ApiResult<{ items: SiteSwitcherItem[] }>> {
	try {
		if (isDeploymentAdmin(actor)) {
			const orgs = await listOrganizations(ctx.controlPlane, actor.id, { all: true });
			const items: SiteSwitcherItem[] = [];
			for (const org of orgs) {
				// oxlint-disable-next-line no-await-in-loop -- one query per organization, few organizations
				for (const site of await listOrgSites(ctx.controlPlane, org.id)) {
					if (site.status !== "active") continue;
					items.push({
						id: site.id,
						name: site.name,
						orgId: org.id,
						orgName: org.name,
						role: Role.ADMIN,
						url: siteUrl(ctx, site.primaryHostname),
					});
				}
			}
			return { success: true, data: { items } };
		}
		const sites = await listSitesForUser(ctx.controlPlane, actor.id);
		const items: SiteSwitcherItem[] = [];
		for (const site of sites) {
			// oxlint-disable-next-line no-await-in-loop -- needs each site's primary hostname
			const detail = await getSite(ctx.controlPlane, site.id);
			items.push({
				id: site.id,
				name: site.name,
				orgId: site.orgId,
				orgName: site.orgName,
				role: site.role,
				url: siteUrl(ctx, detail?.primaryHostname ?? ""),
			});
		}
		return { success: true, data: { items } };
	} catch (error) {
		return fromError(error, "Failed to list sites");
	}
}

export async function handleListOrgs(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
): Promise<ApiResult<{ items: OrganizationSummary[]; canCreate: boolean }>> {
	try {
		const items = await listOrganizations(ctx.controlPlane, actor.id, {
			all: isDeploymentAdmin(actor),
		});
		return { success: true, data: { items, canCreate: hasPermission(actor, "orgs:create") } };
	} catch (error) {
		return fromError(error, "Failed to list organizations");
	}
}

export async function handleCreateOrg(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	input: { slug: string; name: string },
): Promise<ApiResult<{ id: string }>> {
	const denied = requireDeploymentPermission(actor, "orgs:create");
	if (denied) return denied;
	try {
		const taken = await ctx.controlPlane
			.selectFrom("_emdash_orgs")
			.select("id")
			.where("slug", "=", input.slug)
			.executeTakeFirst();
		if (taken) return fail("SLUG_TAKEN", "An organization already uses this slug", 409);
		const org = await createOrganization(ctx.controlPlane, input);
		await setOrgMember(ctx.controlPlane, org.id, actor.id, Role.ADMIN);
		return { success: true, data: { id: org.id } };
	} catch (error) {
		return fromError(error, "Failed to create organization");
	}
}

export interface OrgDetail {
	id: string;
	slug: string;
	name: string;
	viewerRole: RoleLevel | null;
	canManageMembers: boolean;
	canManageSites: boolean;
	sites: Array<SiteDetail & { url: string }>;
	members: Array<{
		userId: string;
		email: string | null;
		name: string | null;
		role: RoleLevel;
		siteRoles: Array<{ siteId: string; role: RoleLevel }>;
	}>;
	invites: Array<{ email: string; role: RoleLevel; createdAt: string }>;
}

export async function handleGetOrg(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	orgId: string,
): Promise<ApiResult<OrgDetail>> {
	try {
		const denied = await checkOrgPermission(ctx, actor, orgId, "orgs:read");
		if (denied) return denied;
		const org = await getOrganization(ctx.controlPlane, orgId);
		if (!org) return fail("NOT_FOUND", "Organization not found");
		const viewerRole = await orgRoleFor(ctx.controlPlane, orgId, actor.id);
		const canManageMembers =
			isDeploymentAdmin(actor) ||
			(viewerRole !== null && hasPermission({ role: viewerRole }, "orgs:members"));
		const [sites, members, invites] = await Promise.all([
			listOrgSites(ctx.controlPlane, orgId),
			listOrgMembers(ctx.controlPlane, orgId),
			canManageMembers ? listOrgInvites(ctx.controlPlane, orgId) : Promise.resolve([]),
		]);
		const accounts =
			members.length > 0
				? await ctx.accounts
						.selectFrom("users")
						.select(["id", "email", "name"])
						.where(
							"id",
							"in",
							members.map((member) => member.userId),
						)
						.execute()
				: [];
		const byId = new Map(accounts.map((account) => [account.id, account]));
		return {
			success: true,
			data: {
				...org,
				viewerRole,
				canManageMembers,
				canManageSites: hasPermission(actor, "sites:manage"),
				sites: sites.map((site) => ({ ...site, url: siteUrl(ctx, site.primaryHostname) })),
				members: members.map((member) => ({
					...member,
					email: byId.get(member.userId)?.email ?? null,
					name: byId.get(member.userId)?.name ?? null,
				})),
				invites,
			},
		};
	} catch (error) {
		return fromError(error, "Failed to load organization");
	}
}

export async function handleRenameOrg(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	orgId: string,
	name: string,
): Promise<ApiResult<{ id: string }>> {
	try {
		const denied = await checkOrgPermission(ctx, actor, orgId, "orgs:members");
		if (denied) return denied;
		await renameOrganization(ctx.controlPlane, orgId, name);
		return { success: true, data: { id: orgId } };
	} catch (error) {
		return fromError(error, "Failed to rename organization");
	}
}

async function hostnameConflict(
	ctx: MultiSiteHandlerContext,
	hostnames: string[],
	siteId: string | null,
): Promise<Failure | null> {
	const normalized = hostnames.map(requireHostname);
	const taken = await ctx.controlPlane
		.selectFrom("_emdash_site_hosts")
		.select(["hostname", "site_id"])
		.where("hostname", "in", normalized)
		.execute();
	const conflict = taken.find((row) => row.site_id !== siteId);
	if (conflict) {
		return fail("HOSTNAME_TAKEN", `Another site already uses ${conflict.hostname}`, 409);
	}
	if (ctx.config.adminUrl && normalized.includes(new URL(ctx.config.adminUrl).hostname)) {
		return fail("HOSTNAME_TAKEN", "The admin host can't also serve a site", 409);
	}
	return null;
}

export async function handleCreateSite(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	orgId: string,
	input: {
		slug: string;
		name: string;
		databaseRef: string;
		storageRef?: string | null;
		hostnames: string[];
	},
): Promise<ApiResult<{ id: string }>> {
	const denied = requireDeploymentPermission(actor, "sites:manage");
	if (denied) return denied;
	try {
		if (!(await getOrganization(ctx.controlPlane, orgId))) {
			return fail("NOT_FOUND", "Organization not found");
		}
		const refs = availableRefs(ctx.config, ctx.deployment);
		if (!refs.databases.includes(input.databaseRef)) {
			return fail("VALIDATION_ERROR", `Unknown database "${input.databaseRef}"`);
		}
		if (input.storageRef && !refs.storages.includes(input.storageRef)) {
			return fail("VALIDATION_ERROR", `Unknown storage "${input.storageRef}"`);
		}
		const conflict = await hostnameConflict(ctx, input.hostnames, null);
		if (conflict) return conflict;
		const slugTaken = await ctx.controlPlane
			.selectFrom("_emdash_sites")
			.select("id")
			.where("org_id", "=", orgId)
			.where("slug", "=", input.slug)
			.executeTakeFirst();
		if (slugTaken)
			return fail("SLUG_TAKEN", "The organization already has a site with this slug", 409);
		const site = await createSite(ctx.controlPlane, { orgId, ...input });
		ctx.invalidateHosts();
		return { success: true, data: { id: site.id } };
	} catch (error) {
		return fromError(error, "Failed to create site");
	}
}

export async function handleUpdateSite(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	siteId: string,
	input: { name?: string; status?: "active" | "disabled"; hostnames?: string[] },
): Promise<ApiResult<{ id: string }>> {
	const denied = requireDeploymentPermission(actor, "sites:manage");
	if (denied) return denied;
	try {
		if (input.hostnames) {
			const conflict = await hostnameConflict(ctx, input.hostnames, siteId);
			if (conflict) return conflict;
		}
		await updateSite(ctx.controlPlane, siteId, input);
		ctx.invalidateHosts();
		return { success: true, data: { id: siteId } };
	} catch (error) {
		return fromError(error, "Failed to update site");
	}
}

export function handleSiteRefs(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
): ApiResult<{ databases: string[]; storages: string[] }> {
	const denied = requireDeploymentPermission(actor, "sites:manage");
	if (denied) return denied;
	return { success: true, data: availableRefs(ctx.config, ctx.deployment) };
}

export async function handleAddMember(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	orgId: string,
	input: { email: string; role: number },
): Promise<ApiResult<{ status: "added" | "invited"; inviteUrl?: string }>> {
	try {
		const denied = await checkOrgPermission(ctx, actor, orgId, "orgs:members");
		if (denied) return denied;
		const role = toRoleLevel(input.role);
		const email = input.email.trim().toLowerCase();
		const account = await ctx.accounts
			.selectFrom("users")
			.select("id")
			.where("email", "=", email)
			.executeTakeFirst();
		if (!account) {
			await inviteToOrg(ctx.controlPlane, { orgId, email, role, invitedBy: actor.id });
			const org = await getOrganization(ctx.controlPlane, orgId);
			const invite = ctx.inviteAccount
				? await ctx.inviteAccount(email, org?.name ?? "EmDash", actor.id)
				: {};
			return { success: true, data: { status: "invited", ...invite } };
		}
		if ((await orgRoleFor(ctx.controlPlane, orgId, account.id)) !== null) {
			return fail("ALREADY_MEMBER", "This person is already a member", 409);
		}
		await setOrgMember(ctx.controlPlane, orgId, account.id, role);
		return { success: true, data: { status: "added" } };
	} catch (error) {
		return fromError(error, "Failed to add member");
	}
}

/** Refuses a change that would leave the organization without an Admin. */
async function keepsAnAdmin(
	ctx: MultiSiteHandlerContext,
	orgId: string,
	userId: string,
	nextRole: RoleLevel | null,
): Promise<Failure | null> {
	const current = await orgRoleFor(ctx.controlPlane, orgId, userId);
	if (current === null) return fail("NOT_FOUND", "Member not found");
	if (current < Role.ADMIN || (nextRole !== null && nextRole >= Role.ADMIN)) return null;
	if ((await countOrgAdmins(ctx.controlPlane, orgId)) > 1) return null;
	return fail("LAST_ORG_ADMIN", "An organization needs at least one Admin", 409);
}

export async function handleUpdateMember(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	orgId: string,
	userId: string,
	roleInput: number,
): Promise<ApiResult<{ userId: string }>> {
	try {
		const denied = await checkOrgPermission(ctx, actor, orgId, "orgs:members");
		if (denied) return denied;
		const role = toRoleLevel(roleInput);
		const blocked = await keepsAnAdmin(ctx, orgId, userId, role);
		if (blocked) return blocked;
		await setOrgMember(ctx.controlPlane, orgId, userId, role);
		return { success: true, data: { userId } };
	} catch (error) {
		return fromError(error, "Failed to change member role");
	}
}

export async function handleRemoveMember(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	orgId: string,
	userId: string,
): Promise<ApiResult<{ userId: string }>> {
	try {
		const denied = await checkOrgPermission(ctx, actor, orgId, "orgs:members");
		if (denied) return denied;
		const blocked = await keepsAnAdmin(ctx, orgId, userId, null);
		if (blocked) return blocked;
		await removeOrgMember(ctx.controlPlane, orgId, userId);
		return { success: true, data: { userId } };
	} catch (error) {
		return fromError(error, "Failed to remove member");
	}
}

export async function handleCancelInvite(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	orgId: string,
	email: string,
): Promise<ApiResult<{ email: string }>> {
	try {
		const denied = await checkOrgPermission(ctx, actor, orgId, "orgs:members");
		if (denied) return denied;
		await cancelOrgInvite(ctx.controlPlane, orgId, email);
		return { success: true, data: { email } };
	} catch (error) {
		return fromError(error, "Failed to cancel invitation");
	}
}

/** Sets (`role` given) or clears (`role` null) a member's role on one site. */
export async function handleSetSiteRole(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	siteId: string,
	userId: string,
	role: number | null,
): Promise<ApiResult<{ userId: string }>> {
	try {
		const site = await getSite(ctx.controlPlane, siteId);
		if (!site) return fail("NOT_FOUND", "Site not found");
		const denied = await checkOrgPermission(ctx, actor, site.orgId, "orgs:members");
		if (denied) return denied;
		if (role === null) await clearSiteRoleOverride(ctx.controlPlane, siteId, userId);
		else await setSiteRoleOverride(ctx.controlPlane, siteId, userId, role);
		return { success: true, data: { userId } };
	} catch (error) {
		return fromError(error, "Failed to change site role");
	}
}

/**
 * Copies an existing site's accounts into the control plane and its
 * organization, for a site that ran on its own before joining the deployment.
 * Deployment Admins only.
 */
export async function handleImportSiteAccounts(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	siteId: string,
): Promise<ApiResult<SiteAccountImport>> {
	const denied = requireDeploymentPermission(actor, "sites:manage");
	if (denied) return denied;
	try {
		const site = await getSite(ctx.controlPlane, siteId);
		if (!site) return fail("NOT_FOUND", "Site not found");
		const siteDb = await ctx.siteDatabase(siteId);
		if (!siteDb)
			return fail("SITE_DISABLED", "Bring the site online before importing its accounts", 409);
		const result = await importSiteAccounts(ctx.controlPlane, ctx.accounts, siteDb, site.orgId);
		return { success: true, data: result };
	} catch (error) {
		return fromError(error, "Failed to import site accounts");
	}
}
