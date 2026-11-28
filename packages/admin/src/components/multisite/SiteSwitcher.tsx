/**
 * Sidebar header of the shared admin in a multi-site deployment: the
 * deployment's logo with the organization and site being managed, and a menu
 * that switches to another site the user can reach. Each site shows its logo,
 * name, and domain; an organization heading appears only when it tells the
 * user something the site's name doesn't.
 */

import { Button, DropdownMenu } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Buildings, CaretUpDown } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { fetchSwitcherSites, type SwitcherSite, switchToSite } from "../../lib/api";
import { BrandIcon } from "../Logo.js";
import { SiteLogoTile, siteDomain } from "./site-logo.js";

interface SiteSwitcherProps {
	currentSiteId: string | null;
	/** The deployment's `admin.logo`, shown in place of the EmDash mark. */
	logoUrl?: string;
	/** The deployment's `admin.siteName`, used as the logo's accessible name. */
	brandName?: string;
}

function sameName(a: string, b: string): boolean {
	return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

function groupByOrganization(sites: SwitcherSite[]) {
	const groups = new Map<string, { name: string; sites: SwitcherSite[] }>();
	for (const site of sites) {
		const group = groups.get(site.orgId) ?? { name: site.orgName, sites: [] };
		group.sites.push(site);
		groups.set(site.orgId, group);
	}
	return Array.from(groups.entries(), ([id, group]) => {
		const only = group.sites.length === 1 ? group.sites[0] : undefined;
		return { id, ...group, showHeading: !only || !sameName(only.name, group.name) };
	}).toSorted((a, b) => a.name.localeCompare(b.name));
}

export function SiteSwitcher({ currentSiteId, logoUrl, brandName }: SiteSwitcherProps) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const { data: sites } = useQuery({
		queryKey: ["multisite", "switcher-sites"],
		queryFn: fetchSwitcherSites,
	});

	const current = sites?.find((site) => site.id === currentSiteId);
	const label = current?.name ?? t`Choose a site`;
	const noDomain = t`No domain yet`;
	const subtitle = current ? (siteDomain(current) ?? noDomain) : (brandName ?? t`Organizations`);
	const groups = sites ? groupByOrganization(sites) : [];

	return (
		<DropdownMenu>
			<DropdownMenu.Trigger
				render={
					<Button
						variant="ghost"
						className="h-auto w-[calc(var(--sidebar-width)-1.75rem)] shrink-0 justify-start gap-2 overflow-hidden py-1 ps-2.5 group-data-[state=collapsed]/sidebar:-translate-x-[3px] rtl:group-data-[state=collapsed]/sidebar:translate-x-[3px]"
						aria-label={t`Switch site, current: ${label}`}
					>
						<BrandIcon
							logoUrl={logoUrl}
							siteName={brandName}
							tile={Boolean(logoUrl)}
							className={
								logoUrl
									? "h-8 w-20 shrink-0 group-data-[state=collapsed]/sidebar:h-6 group-data-[state=collapsed]/sidebar:w-6"
									: "size-5 shrink-0"
							}
							aria-hidden="true"
						/>
						<span className="grid min-w-0 flex-1 grid-cols-[1fr] transition-[grid-template-columns] duration-(--sidebar-animation-duration) ease-(--sidebar-easing) motion-reduce:transition-none group-data-[state=collapsed]/sidebar:grid-cols-[0fr]">
							<span className="flex min-w-0 items-center gap-1 overflow-hidden">
								<span className="grid min-w-0 flex-1 text-start">
									<span className="truncate font-semibold">{label}</span>
									<span className="truncate text-xs font-normal text-kumo-subtle" dir="ltr">
										{subtitle}
									</span>
								</span>
								<CaretUpDown className="size-3.5 shrink-0 text-kumo-subtle" aria-hidden="true" />
							</span>
						</span>
					</Button>
				}
			/>
			<DropdownMenu.Content align="start" className="min-w-[16rem] max-w-80">
				{groups.length > 0 ? (
					groups.map((group, index) => {
						const previous = groups[index - 1];
						const separated = previous && (previous.showHeading || group.showHeading);
						return (
							<DropdownMenu.Group key={group.id}>
								{separated && <DropdownMenu.Separator />}
								{group.showHeading && (
									<DropdownMenu.Label className="text-xs font-medium text-kumo-subtle">
										{group.name}
									</DropdownMenu.Label>
								)}
								{group.sites.map((site) => {
									const isCurrent = site.id === currentSiteId;
									const hostname = siteDomain(site);
									const domain = hostname ?? noDomain;
									return (
										<DropdownMenu.Item
											key={site.id}
											icon={<SiteLogoTile site={site} />}
											selected={isCurrent}
											aria-current={isCurrent ? "true" : undefined}
											onClick={() => {
												if (!isCurrent) switchToSite(site.id);
											}}
										>
											<span className="grid min-w-0 flex-1 text-start">
												<span className="truncate" title={site.name}>
													{site.name}
												</span>
												<span className="truncate text-xs text-kumo-subtle" title={domain}>
													<bdi dir={hostname ? "ltr" : undefined}>{domain}</bdi>
												</span>
											</span>
										</DropdownMenu.Item>
									);
								})}
							</DropdownMenu.Group>
						);
					})
				) : (
					<DropdownMenu.Item
						disabled
					>{t`You don't have access to any sites yet`}</DropdownMenu.Item>
				)}
				<DropdownMenu.Separator />
				<DropdownMenu.Item
					icon={<Buildings className="size-4" aria-hidden="true" />}
					onClick={() => void navigate({ to: "/organizations" })}
				>
					{t`Manage organizations`}
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}
