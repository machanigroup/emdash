import type { RoleLevel } from "@emdash-cms/auth";

import type { EmDashConfig } from "../astro/integration/runtime.js";
import type { SiteRouter } from "../astro/middleware/site.js";
import { apiError } from "./error.js";
import type { MultiSiteActor, MultiSiteHandlerContext } from "./handlers/multisite.js";

/**
 * The handler context and signed-in user for a multi-site management route,
 * or the error response to return. These routes only exist on the shared
 * admin host, where the middleware provides the control plane.
 */
export function multiSiteRequest(locals: {
	emdashMultiSite?: { router: SiteRouter; config: EmDashConfig };
	user?: { id: string; role: RoleLevel };
}): { ctx: MultiSiteHandlerContext; actor: MultiSiteActor } | Response {
	const multiSite = locals.emdashMultiSite;
	if (!multiSite?.config.multiSite) {
		return apiError("NOT_FOUND", "Multi-site management is only available on the admin host", 404);
	}
	const { user } = locals;
	if (!user) return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	const { router } = multiSite;
	return {
		ctx: {
			controlPlane: router.controlPlane,
			accounts: router.controlAccounts,
			config: multiSite.config.multiSite,
			deployment: router.deployment,
			siteDatabase: (siteId: string) => router.siteDatabase(siteId),
			invalidateHosts: () => router.invalidate(),
		},
		actor: { id: user.id, role: user.role },
	};
}
