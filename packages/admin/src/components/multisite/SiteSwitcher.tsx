/**
 * Header control of the shared admin in a multi-site deployment: shows the
 * site being managed and switches to another site the user can reach.
 */

import { Button, DropdownMenu } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Buildings, CaretDown, Check } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { fetchSwitcherSites, switchToSite } from "../../lib/api";

export function SiteSwitcher({ currentSiteId }: { currentSiteId: string | null }) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const { data: sites } = useQuery({
		queryKey: ["multisite", "switcher-sites"],
		queryFn: fetchSwitcherSites,
	});

	const current = sites?.find((site) => site.id === currentSiteId);
	const label = current?.name ?? t`Choose a site`;

	return (
		<DropdownMenu>
			<DropdownMenu.Trigger
				render={
					<Button
						variant="ghost"
						size="sm"
						className="max-w-[14rem] gap-2"
						aria-label={t`Switch site, current: ${label}`}
					>
						<Buildings className="size-4 shrink-0" aria-hidden="true" />
						<span className="truncate">{label}</span>
						<CaretDown className="size-3 shrink-0" aria-hidden="true" />
					</Button>
				}
			/>
			<DropdownMenu.Content align="start" className="min-w-[16rem]">
				{sites && sites.length > 0 ? (
					sites.map((site) => (
						<DropdownMenu.Item
							key={site.id}
							icon={
								site.id === currentSiteId ? (
									<Check className="size-4" aria-hidden="true" />
								) : (
									<span className="size-4" aria-hidden="true" />
								)
							}
							onClick={() => {
								if (site.id !== currentSiteId) switchToSite(site.id);
							}}
						>
							<span className="grid text-start">
								<span className="truncate">{site.name}</span>
								<span className="truncate text-xs text-kumo-subtle">{site.orgName}</span>
							</span>
						</DropdownMenu.Item>
					))
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
					{t`Organizations`}
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}
