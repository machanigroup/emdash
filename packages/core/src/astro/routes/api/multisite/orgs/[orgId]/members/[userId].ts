/**
 * PATCH /_emdash/api/multisite/orgs/:orgId/members/:userId - change a member's role
 * DELETE /_emdash/api/multisite/orgs/:orgId/members/:userId - remove a member from every site in the organization
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, unwrapResult } from "#api/error.js";
import { handleRemoveMember, handleUpdateMember } from "#api/handlers/multisite.js";
import { multiSiteRequest } from "#api/multisite-route.js";
import { isParseError, parseBody } from "#api/parse.js";
import { orgMemberUpdateBody } from "#api/schemas.js";

export const PATCH: APIRoute = async ({ params, request, locals }) => {
	const multiSite = multiSiteRequest(locals);
	if (multiSite instanceof Response) return multiSite;
	if (!params.orgId || !params.userId)
		return apiError("MISSING_PARAM", "Missing organization or user id", 400);
	const body = await parseBody(request, orgMemberUpdateBody);
	if (isParseError(body)) return body;
	return unwrapResult(
		await handleUpdateMember(
			multiSite.ctx,
			multiSite.actor,
			params.orgId,
			params.userId,
			body.role,
		),
	);
};

export const DELETE: APIRoute = async ({ params, locals }) => {
	const multiSite = multiSiteRequest(locals);
	if (multiSite instanceof Response) return multiSite;
	if (!params.orgId || !params.userId)
		return apiError("MISSING_PARAM", "Missing organization or user id", 400);
	return unwrapResult(
		await handleRemoveMember(multiSite.ctx, multiSite.actor, params.orgId, params.userId),
	);
};
