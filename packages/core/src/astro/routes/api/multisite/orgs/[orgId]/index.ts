/**
 * GET /_emdash/api/multisite/orgs/:orgId - the organization with its sites, members, and invitations
 * PATCH /_emdash/api/multisite/orgs/:orgId - rename it
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, unwrapResult } from "#api/error.js";
import { handleGetOrg, handleRenameOrg } from "#api/handlers/multisite.js";
import { multiSiteRequest } from "#api/multisite-route.js";
import { isParseError, parseBody } from "#api/parse.js";
import { orgUpdateBody } from "#api/schemas.js";

export const GET: APIRoute = async ({ params, locals }) => {
	const request = multiSiteRequest(locals);
	if (request instanceof Response) return request;
	if (!params.orgId) return apiError("MISSING_PARAM", "Missing organization id", 400);
	return unwrapResult(await handleGetOrg(request.ctx, request.actor, params.orgId));
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
	const multiSite = multiSiteRequest(locals);
	if (multiSite instanceof Response) return multiSite;
	if (!params.orgId) return apiError("MISSING_PARAM", "Missing organization id", 400);
	const body = await parseBody(request, orgUpdateBody);
	if (isParseError(body)) return body;
	return unwrapResult(
		await handleRenameOrg(multiSite.ctx, multiSite.actor, params.orgId, body.name),
	);
};
