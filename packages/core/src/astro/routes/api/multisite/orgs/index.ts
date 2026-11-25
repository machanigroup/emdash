/**
 * GET /_emdash/api/multisite/orgs - organizations the user can see
 * POST /_emdash/api/multisite/orgs - create an organization (deployment Admins)
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { unwrapResult } from "#api/error.js";
import { handleCreateOrg, handleListOrgs } from "#api/handlers/multisite.js";
import { multiSiteRequest } from "#api/multisite-route.js";
import { isParseError, parseBody } from "#api/parse.js";
import { orgCreateBody } from "#api/schemas.js";

export const GET: APIRoute = async ({ locals }) => {
	const request = multiSiteRequest(locals);
	if (request instanceof Response) return request;
	return unwrapResult(await handleListOrgs(request.ctx, request.actor));
};

export const POST: APIRoute = async ({ request, locals }) => {
	const multiSite = multiSiteRequest(locals);
	if (multiSite instanceof Response) return multiSite;
	const body = await parseBody(request, orgCreateBody);
	if (isParseError(body)) return body;
	return unwrapResult(await handleCreateOrg(multiSite.ctx, multiSite.actor, body), 201);
};
