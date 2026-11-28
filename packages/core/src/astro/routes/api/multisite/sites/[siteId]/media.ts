/**
 * GET /_emdash/api/multisite/sites/:siteId/media
 *
 * One page of another site's media library, for reuse on the site being
 * managed. Read-only; needs media:read on that site.
 */

import type { APIRoute } from "astro";
// @ts-ignore - virtual module
import { createStorage } from "virtual:emdash/storage";

export const prerender = false;

import { apiError, unwrapResult } from "#api/error.js";
import { handleListSharedMedia, siteMediaUrlResolver } from "#api/handlers/shared-media.js";
import { multiSiteRequest } from "#api/multisite-route.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { sharedMediaListQuery } from "#api/schemas.js";

export const GET: APIRoute = async ({ params, url, locals }) => {
	const request = multiSiteRequest(locals);
	if (request instanceof Response) return request;
	const router = locals.emdashMultiSite?.router;
	if (!router) return apiError("NOT_FOUND", "Not found", 404);
	if (!params.siteId) return apiError("MISSING_PARAM", "Missing site id", 400);
	const query = parseQuery(url, sharedMediaListQuery);
	if (isParseError(query)) return query;
	return unwrapResult(
		await handleListSharedMedia(
			request.ctx,
			request.actor,
			params.siteId,
			query,
			async (siteId) => {
				const site = await router.siteById(siteId);
				return site ? siteMediaUrlResolver(site.config, createStorage) : null;
			},
		),
	);
};
