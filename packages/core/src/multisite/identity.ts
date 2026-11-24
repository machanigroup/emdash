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
