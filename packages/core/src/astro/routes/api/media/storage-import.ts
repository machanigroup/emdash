/**
 * Register objects already in the site's storage as media
 *
 * GET /_emdash/api/media/storage-import - List storage objects with no media row
 * POST /_emdash/api/media/storage-import - Register the given storage keys as media
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import {
	handleMediaStorageImport,
	handleMediaStorageScan,
} from "#api/handlers/media-storage-import.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { mediaStorageImportBody, mediaStorageScanQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "media:import_storage");
	if (denied) return denied;
	if (!emdash) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	if (!emdash.storage) return apiError("NO_STORAGE", "Storage not configured", 500);

	const query = parseQuery(new URL(request.url), mediaStorageScanQuery);
	if (isParseError(query)) return query;
	return unwrapResult(
		await handleMediaStorageScan(emdash.db, emdash.storage, {
			prefix: query.prefix,
			cursor: query.cursor,
			limit: query.limit,
			exclude: query.exclude,
		}),
	);
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "media:import_storage");
	if (denied) return denied;
	if (!emdash) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	if (!emdash.storage) return apiError("NO_STORAGE", "Storage not configured", 500);

	const body = await parseBody(request, mediaStorageImportBody);
	if (isParseError(body)) return body;
	return unwrapResult(
		await handleMediaStorageImport(emdash.db, emdash.storage, {
			keys: body.keys,
			folder: body.folder,
			exclude: body.exclude,
			authorId: user?.id,
		}),
	);
};
