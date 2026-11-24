import { createInvite, InviteError, Role, type RoleLevel } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import type { EmDashConfig } from "../astro/integration/runtime.js";
import type { SiteRouter } from "../astro/middleware/site.js";
import type { EmDashHandlers } from "../astro/types.js";
import { apiError } from "./error.js";
import type { MultiSiteActor, MultiSiteHandlerContext } from "./handlers/multisite.js";
import { getSiteBaseUrl } from "./site-url.js";

/**
 * Invites an email to create an account on the admin host, so someone added
 * to an organization before they have an account can sign in and join it.
 * The account gets no deployment-wide role; its access comes from the
 * organization invitation. Returns the link to share when no email provider
 * is configured.
 */
function accountInviter(
	emdash: Pick<EmDashHandlers, "db" | "email" | "config">,
	request: Request,
): (email: string, organizationName: string, invitedBy: string) => Promise<{ inviteUrl?: string }> {
	return async (email, organizationName, invitedBy) => {
		const emailSend = emdash.email?.isAvailable()
			? (message: { to: string; subject: string; text: string; html?: string }) =>
					emdash.email!.send(message, "system")
			: undefined;
		try {
			const result = await createInvite(
				{
					baseUrl: await getSiteBaseUrl(emdash.db, request, emdash.config),
					siteName: organizationName,
					email: emailSend,
				},
				createKyselyAdapter(emdash.db),
				email,
				Role.SUBSCRIBER,
				invitedBy,
			);
			return emailSend ? {} : { inviteUrl: result.url };
		} catch (error) {
			if (error instanceof InviteError && error.code === "user_exists") return {};
			throw error;
		}
	};
}

/**
 * The handler context and signed-in user for a multi-site management route,
 * or the error response to return. These routes only exist on the shared
 * admin host, where the middleware provides the control plane.
 */
export function multiSiteRequest(
	locals: {
		emdashMultiSite?: { router: SiteRouter; config: EmDashConfig };
		emdash?: Pick<EmDashHandlers, "db" | "email" | "config">;
		user?: { id: string; role: RoleLevel };
	},
	request?: Request,
): { ctx: MultiSiteHandlerContext; actor: MultiSiteActor } | Response {
	const multiSite = locals.emdashMultiSite;
	if (!multiSite?.config.multiSite) {
		return apiError("NOT_FOUND", "Multi-site management is only available on the admin host", 404);
	}
	const { user, emdash } = locals;
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
			...(emdash && request ? { inviteAccount: accountInviter(emdash, request) } : {}),
		},
		actor: { id: user.id, role: user.role },
	};
}
