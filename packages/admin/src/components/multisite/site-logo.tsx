import * as React from "react";

import type { SwitcherSite } from "../../lib/api/multisite.js";
import { BrandIcon } from "../Logo.js";

const LEADING_WWW = /^www\./;

export function siteDomain(site: SwitcherSite): string | null {
	if (!site.url) return null;
	try {
		return new URL(site.url).host.replace(LEADING_WWW, "");
	} catch {
		return site.url;
	}
}

function initial(name: string): string {
	const [first] = new Intl.Segmenter().segment(name.trim());
	return first ? first.segment.toLocaleUpperCase() : "";
}

export function SiteLogoTile({ site }: { site: SwitcherSite }) {
	const [failed, setFailed] = React.useState(false);
	if (site.logoUrl && !failed) {
		return (
			<BrandIcon
				logoUrl={site.logoUrl}
				tile
				className="size-8 shrink-0"
				onError={() => setFailed(true)}
			/>
		);
	}
	return (
		<span
			data-testid="site-logo-fallback"
			className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-tint text-sm font-semibold text-kumo-subtle ring-1 ring-kumo-line"
			aria-hidden="true"
		>
			{initial(site.name)}
		</span>
	);
}
