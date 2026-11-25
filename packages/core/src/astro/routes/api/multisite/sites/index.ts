/**
 * GET /_emdash/api/multisite/sites
 *
 * Sites the signed-in user can manage, for the admin's site switcher.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { unwrapResult } from "#api/error.js";
import { handleListMySites } from "#api/handlers/multisite.js";
import { multiSiteRequest } from "#api/multisite-route.js";

export const GET: APIRoute = async ({ locals }) => {
	const request = multiSiteRequest(locals);
	if (request instanceof Response) return request;
	return unwrapResult(await handleListMySites(request.ctx, request.actor));
};
