/**
 * GET /_emdash/api/multisite/media-sources
 *
 * Sites whose media library the signed-in user may browse, for the admin's
 * media source selector.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { unwrapResult } from "#api/error.js";
import { handleListSharedMediaSources } from "#api/handlers/shared-media.js";
import { multiSiteRequest } from "#api/multisite-route.js";

export const GET: APIRoute = async ({ locals }) => {
	const request = multiSiteRequest(locals);
	if (request instanceof Response) return request;
	return unwrapResult(await handleListSharedMediaSources(request.ctx, request.actor));
};
