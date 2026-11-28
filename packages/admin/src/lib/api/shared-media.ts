/**
 * Media libraries of the other sites a person can reach in a multi-site
 * deployment. Their media is read-only from here: it is browsed and picked by
 * its public URL, and stays in the library of the site it belongs to.
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { API_BASE, apiFetch, fetchManifest, parseApiResponse } from "./client.js";
import { normalizeMediaSearch, type MediaItem, type MediaProviderItem } from "./media.js";

const BASE = `${API_BASE}/multisite`;
const SOURCE_PREFIX = "site:";

export interface SharedMediaSource {
	id: string;
	name: string;
	orgId: string;
	orgName: string;
}

export interface SharedMediaPage {
	items: MediaProviderItem[];
	nextCursor?: string;
}

interface SharedMediaResponseItem {
	id: string;
	filename: string;
	mimeType: string;
	url: string;
	size: number | null;
	width: number | null;
	height: number | null;
	alt: string | null;
	caption: string | null;
	blurhash: string | null;
	dominantColor: string | null;
	site: { id: string; name: string };
}

/** The media source id the browsers use for another site's library. */
export function sharedMediaSourceId(siteId: string): string {
	return `${SOURCE_PREFIX}${siteId}`;
}

export function isSharedMediaSourceId(sourceId: string): boolean {
	return sourceId.startsWith(SOURCE_PREFIX);
}

export async function fetchSharedMediaSources(): Promise<SharedMediaSource[]> {
	const response = await apiFetch(`${BASE}/media-sources`);
	const data = await parseApiResponse<{ items: SharedMediaSource[] }>(
		response,
		i18n._(msg`Failed to load other sites' media libraries`),
	);
	return data.items;
}

/** One page of another site's media, as provider items whose preview URL is the file's public URL. */
export async function fetchSharedMedia(
	siteId: string,
	options: { cursor?: string; limit?: number; search?: string; mimeType?: string | string[] } = {},
): Promise<SharedMediaPage> {
	const params = new URLSearchParams();
	if (options.cursor) params.set("cursor", options.cursor);
	if (options.limit) params.set("limit", String(options.limit));
	if (options.mimeType) {
		const value = Array.isArray(options.mimeType) ? options.mimeType.join(",") : options.mimeType;
		if (value) params.set("mimeType", value);
	}
	const q = normalizeMediaSearch(options.search);
	if (q) params.set("q", q);
	const query = params.toString();
	const response = await apiFetch(
		`${BASE}/sites/${encodeURIComponent(siteId)}/media${query ? `?${query}` : ""}`,
	);
	const data = await parseApiResponse<{ items: SharedMediaResponseItem[]; nextCursor?: string }>(
		response,
		i18n._(msg`Failed to load this site's media`),
	);
	return {
		items: data.items.map((item) => ({
			id: item.id,
			filename: item.filename,
			mimeType: item.mimeType,
			size: item.size ?? undefined,
			width: item.width ?? undefined,
			height: item.height ?? undefined,
			alt: item.alt ?? undefined,
			caption: item.caption ?? undefined,
			blurhash: item.blurhash ?? undefined,
			dominantColor: item.dominantColor ?? undefined,
			previewUrl: item.url,
		})),
		nextCursor: data.nextCursor,
	};
}

/**
 * The media item that content stores for a pick from another site: an
 * external image by its absolute URL, so the current site renders it without
 * looking it up in its own library.
 */
export function sharedItemToMediaItem(item: MediaProviderItem): MediaItem {
	return {
		id: "",
		filename: item.filename,
		mimeType: item.mimeType,
		url: item.previewUrl ?? "",
		size: item.size ?? 0,
		width: item.width,
		height: item.height,
		blurhash: item.blurhash,
		dominantColor: item.dominantColor,
		alt: item.alt,
		caption: item.caption,
		createdAt: new Date().toISOString(),
		provider: "external",
	};
}

/**
 * The other sites whose media the user may browse. Empty outside the shared
 * admin of a multi-site deployment and for people who can reach one site.
 */
export function useSharedMediaSources(enabled = true): SharedMediaSource[] {
	const { data: manifest } = useQuery({ queryKey: ["manifest"], queryFn: fetchManifest, enabled });
	const currentSiteId = manifest?.multiSite?.siteId ?? null;
	const { data } = useQuery({
		queryKey: ["multisite", "media-sources"],
		queryFn: fetchSharedMediaSources,
		enabled: enabled && currentSiteId !== null,
		staleTime: 60_000,
		retry: false,
	});
	return React.useMemo(
		() => (data ?? []).filter((site) => site.id !== currentSiteId),
		[currentSiteId, data],
	);
}
