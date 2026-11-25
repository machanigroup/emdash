/**
 * POST /_emdash/api/multisite/sites/:siteId/import-accounts
 *
 * Copies a site's existing accounts into the control plane and the site's
 * organization. Deployment Admins only.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, unwrapResult } from "#api/error.js";
import { handleImportSiteAccounts } from "#api/handlers/multisite.js";
import { multiSiteRequest } from "#api/multisite-route.js";

export const POST: APIRoute = async ({ params, locals }) => {
	const multiSite = multiSiteRequest(locals);
	if (multiSite instanceof Response) return multiSite;
	if (!params.siteId) return apiError("MISSING_PARAM", "Missing site id", 400);
	return unwrapResult(
		await handleImportSiteAccounts(multiSite.ctx, multiSite.actor, params.siteId),
	);
};
