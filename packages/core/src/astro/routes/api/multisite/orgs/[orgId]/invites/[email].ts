/**
 * DELETE /_emdash/api/multisite/orgs/:orgId/invites/:email
 *
 * Cancels an invitation that hasn't been accepted.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, unwrapResult } from "#api/error.js";
import { handleCancelInvite } from "#api/handlers/multisite.js";
import { multiSiteRequest } from "#api/multisite-route.js";

export const DELETE: APIRoute = async ({ params, locals }) => {
	const multiSite = multiSiteRequest(locals);
	if (multiSite instanceof Response) return multiSite;
	if (!params.orgId || !params.email)
		return apiError("MISSING_PARAM", "Missing organization or email", 400);
	return unwrapResult(
		await handleCancelInvite(
			multiSite.ctx,
			multiSite.actor,
			params.orgId,
			decodeURIComponent(params.email),
		),
	);
};
