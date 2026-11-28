/**
 * Names the site a page changes on the shared admin of a multi-site
 * deployment, so settings saved there land on the site the user meant.
 */

import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";

import { fetchManifest, fetchSwitcherSites, type SwitcherSite } from "../../lib/api";
import { SiteLogoTile, siteDomain } from "./site-logo.js";

/** The site the shared admin is managing, or null outside multi-site mode and on the control plane. */
export function useCurrentSite(): SwitcherSite | null {
	const { data: manifest } = useQuery({ queryKey: ["manifest"], queryFn: fetchManifest });
	const siteId = manifest?.multiSite?.siteId ?? null;
	const { data: sites } = useQuery({
		queryKey: ["multisite", "switcher-sites"],
		queryFn: fetchSwitcherSites,
		enabled: siteId !== null,
	});
	return (siteId && sites?.find((site) => site.id === siteId)) || null;
}

export function SiteContext({ className }: { className?: string }) {
	const site = useCurrentSite();
	if (!site) return null;
	const domain = siteDomain(site);
	const name = site.name;
	return (
		<div
			data-testid="site-context"
			className={`inline-flex max-w-full items-center gap-2 rounded-xl border border-kumo-line bg-kumo-base py-1 ps-1 pe-3 ${className ?? ""}`}
		>
			<SiteLogoTile site={site} />
			<span className="grid min-w-0 text-start">
				<span className="truncate text-sm">
					<Trans>
						Editing <strong className="font-semibold">{name}</strong>
					</Trans>
				</span>
				{domain && (
					<span className="truncate text-xs text-kumo-subtle">
						<bdi dir="ltr">{domain}</bdi>
					</span>
				)}
			</span>
		</div>
	);
}
