import { toRoleLevel, type RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import type { ControlPlaneDatabase } from "./types.js";

/**
 * The role a user holds on one site: the site's override when one exists,
 * otherwise the user's role in the site's organization. A user who is not a
 * member of the organization has no role, even with an override, so removing a
 * member revokes every site at once. Disabled and unknown sites grant nothing.
 */
export async function resolveEffectiveRole(
	db: Kysely<ControlPlaneDatabase>,
	siteId: string,
	userId: string,
): Promise<RoleLevel | null> {
	const row = await db
		.selectFrom("_emdash_sites as s")
		.innerJoin("_emdash_org_members as m", (join) =>
			join.onRef("m.org_id", "=", "s.org_id").on("m.user_id", "=", userId),
		)
		.leftJoin("_emdash_site_role_overrides as o", (join) =>
			join.onRef("o.site_id", "=", "s.id").on("o.user_id", "=", userId),
		)
		.select(["m.role as org_role", "o.role as override_role"])
		.where("s.id", "=", siteId)
		.where("s.status", "=", "active")
		.executeTakeFirst();
	if (!row) return null;
	return toRoleLevel(row.override_role ?? row.org_role);
}
