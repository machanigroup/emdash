/**
 * POST /_emdash/api/multisite/orgs/:orgId/sites
 *
 * Adds a site to an organization. Deployment Admins only.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, unwrapResult } from "#api/error.js";
import { handleCreateSite } from "#api/handlers/multisite.js";
import { multiSiteRequest } from "#api/multisite-route.js";
import { isParseError, parseBody } from "#api/parse.js";
import { siteCreateBody } from "#api/schemas.js";

export const POST: APIRoute = async ({ params, request, locals }) => {
	const multiSite = multiSiteRequest(locals);
	if (multiSite instanceof Response) return multiSite;
	if (!params.orgId) return apiError("MISSING_PARAM", "Missing organization id", 400);
	const body = await parseBody(request, siteCreateBody);
	if (isParseError(body)) return body;
	return unwrapResult(
		await handleCreateSite(multiSite.ctx, multiSite.actor, params.orgId, body),
		201,
	);
};
