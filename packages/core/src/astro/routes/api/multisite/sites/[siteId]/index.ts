/**
 * PATCH /_emdash/api/multisite/sites/:siteId
 *
 * Changes a site's name, status, or hostnames. Deployment Admins only.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, unwrapResult } from "#api/error.js";
import { handleUpdateSite } from "#api/handlers/multisite.js";
import { multiSiteRequest } from "#api/multisite-route.js";
import { isParseError, parseBody } from "#api/parse.js";
import { siteUpdateBody } from "#api/schemas.js";

export const PATCH: APIRoute = async ({ params, request, locals }) => {
	const multiSite = multiSiteRequest(locals);
	if (multiSite instanceof Response) return multiSite;
	if (!params.siteId) return apiError("MISSING_PARAM", "Missing site id", 400);
	const body = await parseBody(request, siteUpdateBody);
	if (isParseError(body)) return body;
	return unwrapResult(await handleUpdateSite(multiSite.ctx, multiSite.actor, params.siteId, body));
};
