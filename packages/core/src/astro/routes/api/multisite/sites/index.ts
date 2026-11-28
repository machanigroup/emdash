/**
 * GET /_emdash/api/multisite/sites
 *
 * Sites the signed-in user can manage, with each site's logo, for the admin's site switcher.
 */

import type { APIRoute } from "astro";
// @ts-ignore - virtual module
import { createStorage } from "virtual:emdash/storage";

export const prerender = false;

import { unwrapResult } from "#api/error.js";
import { handleListMySites } from "#api/handlers/multisite.js";
import { siteMediaUrlResolver } from "#api/handlers/shared-media.js";
import { multiSiteRequest } from "#api/multisite-route.js";

export const GET: APIRoute = async ({ locals }) => {
	const request = multiSiteRequest(locals);
	if (request instanceof Response) return request;
	const router = locals.emdashMultiSite?.router;
	return unwrapResult(
		await handleListMySites(
			request.ctx,
			request.actor,
			router
				? async (siteId) => {
						const site = await router.siteById(siteId);
						return site ? siteMediaUrlResolver(site.config, createStorage) : null;
					}
				: undefined,
		),
	);
};
