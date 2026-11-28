/**
 * Media from other sites of a multi-site deployment, browsed from the shared
 * admin so a person who works on several sites can reuse one site's images on
 * another. Other sites' media is read-only here: it is listed and picked by its
 * public URL, never uploaded to, edited, or deleted.
 */

import { hasPermission, Role, type RoleLevel } from "@emdash-cms/auth";

import type { EmDashConfig } from "../../astro/integration/runtime.js";
import type { MediaItem } from "../../database/repositories/media.js";
import { localMediaFileUrl } from "../../media/url.js";
import { getSite } from "../../multisite/repository.js";
import { resolveEffectiveRole } from "../../multisite/roles.js";
import type { Storage } from "../../storage/types.js";
import type { ApiResult } from "../types.js";
import { handleMediaList } from "./media.js";
import {
	handleListMySites,
	type MultiSiteActor,
	type MultiSiteHandlerContext,
} from "./multisite.js";

export interface SharedMediaSource {
	id: string;
	name: string;
	orgId: string;
	orgName: string;
}

export interface SharedMediaItem extends MediaItem {
	/** Absolute URL that serves the file from the site it belongs to. */
	url: string;
	site: { id: string; name: string };
}

export interface SharedMediaList {
	items: SharedMediaItem[];
	nextCursor?: string;
	totalCount?: number;
}

/** The absolute public URL of a storage key, or null when the site has no public address. */
export type SharedMediaUrl = (storageKey: string) => string | null;

const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the absolute URL of a site's media files: the storage's public URL
 * when it has one (a CDN or bucket domain), otherwise the media file route on
 * the site's own hostname. Returns null for each key when the site has neither.
 */
export function siteMediaUrlResolver(
	config: Pick<EmDashConfig, "siteUrl" | "storage">,
	createStorage: ((config: Record<string, unknown>) => Storage) | null | undefined,
): SharedMediaUrl {
	let storage: Storage | null = null;
	const storageOptions = config.storage?.config;
	if (isRecord(storageOptions) && createStorage) {
		try {
			storage = createStorage(storageOptions);
		} catch (error) {
			console.error("[emdash:multisite] opening a site's media storage failed:", error);
		}
	}
	let origin: string | null = null;
	if (config.siteUrl) {
		try {
			origin = new URL(config.siteUrl).origin;
		} catch {
			origin = null;
		}
	}
	return (storageKey) => {
		const url = storage ? storage.getPublicUrl(storageKey) : localMediaFileUrl(storageKey);
		if (ABSOLUTE_HTTP_URL.test(url)) return url;
		if (!origin || !url.startsWith("/") || url.startsWith("//")) return null;
		return new URL(url, origin).href;
	};
}

type Failure = Extract<ApiResult<never>, { success: false }>;

function fail(code: string, message: string, status?: number): Failure {
	return { success: false, error: { code, message }, ...(status ? { status } : {}) };
}

async function siteRole(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	siteId: string,
): Promise<RoleLevel | null> {
	if (actor.role >= Role.ADMIN) return Role.ADMIN;
	return resolveEffectiveRole(ctx.controlPlane, siteId, actor.id);
}

/** Every active site whose media the user may read, including the one they are managing. */
export async function handleListSharedMediaSources(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
): Promise<ApiResult<{ items: SharedMediaSource[] }>> {
	const sites = await handleListMySites(ctx, actor);
	if (!sites.success) return sites;
	return {
		success: true,
		data: {
			items: sites.data.items
				.filter((site) => hasPermission({ role: site.role }, "media:read"))
				.map(({ id, name, orgId, orgName }) => ({ id, name, orgId, orgName })),
		},
	};
}

/**
 * One page of another site's media library, in the shape of the media list
 * endpoint, with absolute URLs. A site the user can't reach answers as not
 * found, so its existence isn't revealed.
 */
export async function handleListSharedMedia(
	ctx: MultiSiteHandlerContext,
	actor: MultiSiteActor,
	siteId: string,
	params: {
		cursor?: string;
		page?: number;
		limit?: number;
		mimeType?: string | readonly string[];
		q?: string;
	},
	mediaUrls: (siteId: string) => Promise<SharedMediaUrl | null>,
): Promise<ApiResult<SharedMediaList>> {
	try {
		const site = await getSite(ctx.controlPlane, siteId);
		const role = site?.status === "active" ? await siteRole(ctx, actor, siteId) : null;
		if (!site || role === null) return fail("NOT_FOUND", "Site not found");
		if (!hasPermission({ role }, "media:read")) {
			return fail("FORBIDDEN", "Insufficient permissions");
		}
		const [siteDb, urlFor] = await Promise.all([ctx.siteDatabase(siteId), mediaUrls(siteId)]);
		if (!siteDb || !urlFor) return fail("NOT_FOUND", "Site not found");

		const result = await handleMediaList(siteDb, params);
		if (!result.success) return result;

		const items: SharedMediaItem[] = [];
		for (const item of result.data.items) {
			const url = urlFor(item.storageKey);
			if (!url) {
				return fail(
					"MEDIA_NOT_PUBLIC",
					"This site's media has no public address. Give the site a hostname or a public storage URL.",
					409,
				);
			}
			items.push({ ...item, url, site: { id: site.id, name: site.name } });
		}
		return {
			success: true,
			data: {
				items,
				...(result.data.nextCursor ? { nextCursor: result.data.nextCursor } : {}),
				...(result.data.totalCount !== undefined ? { totalCount: result.data.totalCount } : {}),
			},
		};
	} catch (error) {
		console.error("[emdash:multisite] listing another site's media failed:", error);
		return fail("MULTISITE_ERROR", "Failed to list media", 500);
	}
}
