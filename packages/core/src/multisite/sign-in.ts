import { Role, type RoleLevel } from "@emdash-cms/auth";

import type { EmDashConfig } from "../astro/integration/runtime.js";
import { getRequestContext } from "../request-context.js";
import { CONTROL_PLANE_SITE_ID } from "./ids.js";

/**
 * The email domains allowed to sign in on the shared admin host, or null when
 * the request isn't on the admin host or no domains are configured. With a
 * list, only those domains can create an account without an invitation,
 * including the first administrator, and accounts are created through a sign-in
 * provider that verifies the email address.
 */
export function adminHostSignInDomains(config: EmDashConfig | null | undefined): string[] | null {
	const multiSite = config?.multiSite;
	if (!multiSite?.adminUrl || !multiSite.signInDomains?.length) return null;
	if (getRequestContext()?.siteId !== CONTROL_PLANE_SITE_ID) return null;
	return multiSite.signInDomains.map((domain) => domain.trim().toLowerCase());
}

export function emailInDomains(email: string, domains: readonly string[]): boolean {
	const domain = email.split("@").pop()?.trim().toLowerCase();
	return !!domain && domains.includes(domain);
}

/**
 * Whether someone without an account may create one by signing in with a
 * provider on the shared admin host, and with what deployment-wide role.
 * Returns undefined when the admin host has no sign-in domains, so the usual
 * single-site rules apply. The first account becomes the deployment Admin;
 * later ones get no deployment-wide role, since site access comes from
 * organization membership.
 */
export function adminHostSignup(
	config: EmDashConfig | null | undefined,
	email: string,
	setupComplete: boolean,
): { allowed: true; role: RoleLevel } | null | undefined {
	const domains = adminHostSignInDomains(config);
	if (!domains) return undefined;
	if (!emailInDomains(email, domains)) return null;
	return { allowed: true, role: setupComplete ? Role.SUBSCRIBER : Role.ADMIN };
}
