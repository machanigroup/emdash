import { useQuery } from "@tanstack/react-query";

import { fetchSwitcherSites } from "./api";

/**
 * The origin of the site being edited on a multi-site admin host, such as
 * `https://example.com`, or null when the admin and the site share an origin or the
 * site has no hostname yet. Shares the site switcher's query.
 */
export function useSiteOrigin(siteId: string | null | undefined): string | null {
	const { data } = useQuery({
		queryKey: ["multisite", "switcher-sites"],
		queryFn: fetchSwitcherSites,
		enabled: Boolean(siteId),
	});
	const url = siteId ? data?.find((site) => site.id === siteId)?.url : null;
	if (!url) return null;
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/** Puts a root-relative path on `origin`. Absolute URLs, and every path without an origin, are returned as they are. */
export function onSiteOrigin(path: string, origin: string | null): string {
	if (!origin || !path.startsWith("/") || path.startsWith("//")) return path;
	return new URL(path, origin).toString();
}
