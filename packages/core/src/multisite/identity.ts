import { Role, toRoleLevel, type RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";
import { MultiSiteError } from "./errors.js";
import { resolveEffectiveRole } from "./roles.js";
import type { ControlPlaneDatabase } from "./types.js";

/** A user account in the control plane, where sign-in happens. */
export interface ControlPlaneUser {
	id: string;
	email: string;
	name: string | null;
	avatarUrl: string | null;
	role: RoleLevel;
	emailVerified: boolean;
	disabled: boolean;
}

export async function findControlPlaneUser(
	controlDb: Kysely<Database>,
	userId: string,
): Promise<ControlPlaneUser | null> {
	const row = await controlDb
		.selectFrom("users")
		.select(["id", "email", "name", "avatar_url", "role", "email_verified", "disabled"])
		.where("id", "=", userId)
		.executeTakeFirst();
	if (!row) return null;
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		avatarUrl: row.avatar_url,
		role: toRoleLevel(row.role),
		emailVerified: row.email_verified === 1,
		disabled: row.disabled === 1,
	};
}

/**
 * The role a control-plane user holds on a site. Deployment Admins (Admin in
 * the control plane) are Admin on every site; everyone else gets their
 * organization role or the site's override, or nothing.
 */
export async function siteRoleFor(
	controlPlane: Kysely<ControlPlaneDatabase>,
	user: ControlPlaneUser,
	siteId: string,
): Promise<RoleLevel | null> {
	if (user.disabled) return null;
	if (user.role >= Role.ADMIN) return Role.ADMIN;
	return resolveEffectiveRole(controlPlane, siteId, user.id);
}

/**
 * Copies a control-plane user into a site's `users` table with the role they
 * hold on that site. Content, revisions, bylines, comments, and the auth
 * middleware all read users from the site's own database, so each site keeps
 * a copy under the same id. Writes only when the copy differs.
 */
export async function syncSiteUser(
	siteDb: Kysely<Database>,
	user: ControlPlaneUser,
	role: RoleLevel,
): Promise<void> {
	const existing = await siteDb
		.selectFrom("users")
		.select(["email", "name", "avatar_url", "role", "email_verified", "disabled"])
		.where("id", "=", user.id)
		.executeTakeFirst();
	const values = {
		email: user.email,
		name: user.name,
		avatar_url: user.avatarUrl,
		role,
		email_verified: user.emailVerified ? 1 : 0,
		disabled: user.disabled ? 1 : 0,
	};
	if (
		existing &&
		existing.email === values.email &&
		existing.name === values.name &&
		existing.avatar_url === values.avatar_url &&
		existing.role === values.role &&
		existing.email_verified === values.email_verified &&
		existing.disabled === values.disabled
	) {
		return;
	}

	const now = new Date().toISOString();
	if (existing) {
		await siteDb
			.updateTable("users")
			.set({ ...values, updated_at: now })
			.where("id", "=", user.id)
			.execute();
		return;
	}

	const sameEmail = await siteDb
		.selectFrom("users")
		.select("id")
		.where("email", "=", user.email)
		.executeTakeFirst();
	if (sameEmail) {
		throw new MultiSiteError(
			"ACCOUNT_CONFLICT",
			"The site already has a separate account with this email address",
		);
	}
	await siteDb
		.insertInto("users")
		.values({ id: user.id, ...values, created_at: now, updated_at: now })
		.execute();
}

/**
 * Marks a site's setup complete when it was created through the control
 * plane, so its admin opens instead of the first-run setup wizard. The site
 * name becomes the site title unless one is already set.
 */
export async function ensureSiteSetUp(siteDb: Kysely<Database>, siteName: string): Promise<void> {
	const options = new OptionsRepository(siteDb);
	const complete = await options.get("emdash:setup_complete");
	if (complete === true || complete === "true") return;
	await options.setIfAbsent("emdash:site_title", siteName);
	await options.set("emdash:setup_complete", true);
}

/**
 * Rechecks a user's access to a site against the control plane, as every
 * authenticated request on the site's own hostname does: API tokens and
 * sessions there are issued for the site's copy of the account, so a removal or
 * role change in the control plane must reach the copy before the request is
 * trusted. Returns the role to use, or null when the account has no access.
 * A copy whose control-plane account lost access is disabled; an account the
 * control plane doesn't know is denied without changing the site.
 */
export async function refreshSiteAccount(
	controlPlane: Kysely<ControlPlaneDatabase>,
	controlAccounts: Kysely<Database>,
	siteDb: Kysely<Database>,
	siteId: string,
	userId: string,
): Promise<RoleLevel | null> {
	const user = await findControlPlaneUser(controlAccounts, userId);
	if (!user) return null;
	const role = await siteRoleFor(controlPlane, user, siteId);
	if (role !== null) {
		await syncSiteUser(siteDb, user, role);
		return role;
	}
	await siteDb
		.updateTable("users")
		.set({ disabled: 1, updated_at: new Date().toISOString() })
		.where("id", "=", userId)
		.where("disabled", "=", 0)
		.execute();
	return null;
}

export interface SiteAccountImport {
	/** Accounts created in the control plane under their site id. */
	imported: number;
	/** Site accounts the control plane already had under the same id. */
	linked: number;
	/** Emails that belong to a different control-plane account and were skipped. */
	conflicts: string[];
}

/**
 * Brings a site's existing accounts into the control plane, so the people who
 * already work on the site can sign in on the admin host. Each account keeps
 * its id, which is what the site's content, revisions, and bylines refer to,
 * and joins the site's organization with the role it had on the site. Imported
 * accounts are never deployment Admins. Passkeys aren't copied: they belong
 * to the site's old hostname, so people sign in on the admin host with
 * another method and add a passkey there.
 */
export async function importSiteAccounts(
	controlPlane: Kysely<ControlPlaneDatabase>,
	controlAccounts: Kysely<Database>,
	siteDb: Kysely<Database>,
	orgId: string,
): Promise<SiteAccountImport> {
	const siteUsers = await siteDb
		.selectFrom("users")
		.select(["id", "email", "name", "avatar_url", "role", "email_verified", "disabled"])
		.execute();
	const result: SiteAccountImport = { imported: 0, linked: 0, conflicts: [] };
	for (const siteUser of siteUsers) {
		// oxlint-disable-next-line no-await-in-loop -- one account at a time keeps each check and write together
		const existing = await controlAccounts
			.selectFrom("users")
			.select(["id"])
			.where((eb) => eb.or([eb("id", "=", siteUser.id), eb("email", "=", siteUser.email)]))
			.execute();
		if (existing.some((row) => row.id !== siteUser.id)) {
			result.conflicts.push(siteUser.email);
			continue;
		}
		if (existing.length === 0) {
			const now = new Date().toISOString();
			// oxlint-disable-next-line no-await-in-loop -- see above
			await controlAccounts
				.insertInto("users")
				.values({
					id: siteUser.id,
					email: siteUser.email,
					name: siteUser.name,
					avatar_url: siteUser.avatar_url,
					role: Role.SUBSCRIBER,
					email_verified: siteUser.email_verified,
					disabled: siteUser.disabled,
					created_at: now,
					updated_at: now,
				})
				.execute();
			result.imported++;
		} else {
			result.linked++;
		}
		if (siteUser.disabled === 1) continue;
		// oxlint-disable-next-line no-await-in-loop -- see above
		await controlPlane
			.insertInto("_emdash_org_members")
			.values({ org_id: orgId, user_id: siteUser.id, role: toRoleLevel(siteUser.role) })
			.onConflict((oc) => oc.columns(["org_id", "user_id"]).doNothing())
			.execute();
	}
	return result;
}
