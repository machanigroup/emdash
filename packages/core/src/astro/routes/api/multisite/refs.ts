/**
 * GET /_emdash/api/multisite/refs
 *
 * Database and storage names a new site can use. Deployment Admins only.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { unwrapResult } from "#api/error.js";
import { handleSiteRefs } from "#api/handlers/multisite.js";
import { multiSiteRequest } from "#api/multisite-route.js";

export const GET: APIRoute = ({ locals }) => {
	const request = multiSiteRequest(locals);
	if (request instanceof Response) return request;
	return unwrapResult(handleSiteRefs(request.ctx, request.actor));
};
