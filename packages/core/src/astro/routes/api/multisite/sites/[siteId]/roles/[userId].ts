/**
 * PUT /_emdash/api/multisite/sites/:siteId/roles/:userId - give a member a different role on one site
 * DELETE /_emdash/api/multisite/sites/:siteId/roles/:userId - go back to their organization role
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, unwrapResult } from "#api/error.js";
import { handleSetSiteRole } from "#api/handlers/multisite.js";
import { multiSiteRequest } from "#api/multisite-route.js";
import { isParseError, parseBody } from "#api/parse.js";
import { siteRoleBody } from "#api/schemas.js";

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const multiSite = multiSiteRequest(locals);
	if (multiSite instanceof Response) return multiSite;
	if (!params.siteId || !params.userId)
		return apiError("MISSING_PARAM", "Missing site or user id", 400);
	const body = await parseBody(request, siteRoleBody);
	if (isParseError(body)) return body;
	return unwrapResult(
		await handleSetSiteRole(
			multiSite.ctx,
			multiSite.actor,
			params.siteId,
			params.userId,
			body.role,
		),
	);
};

export const DELETE: APIRoute = async ({ params, locals }) => {
	const multiSite = multiSiteRequest(locals);
	if (multiSite instanceof Response) return multiSite;
	if (!params.siteId || !params.userId)
		return apiError("MISSING_PARAM", "Missing site or user id", 400);
	return unwrapResult(
		await handleSetSiteRole(multiSite.ctx, multiSite.actor, params.siteId, params.userId, null),
	);
};
