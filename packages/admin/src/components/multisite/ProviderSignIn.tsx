/**
 * Sign-in card for the shared admin of a multi-site deployment, where people
 * sign in only through the configured providers, such as Google.
 */

import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useAdminBranding } from "../../lib/admin-branding-context";
import { useAuthProviderList } from "../../lib/auth-provider-context";
import { SignInLogo } from "../Logo.js";

export function ProviderSignIn({
	title,
	description,
	error,
	accessHelp = false,
}: {
	title: string;
	description: React.ReactNode;
	error?: string | null;
	/** Names the companies this admin covers and explains who can sign in and what to do when it fails. */
	accessHelp?: boolean;
}) {
	const { t, i18n } = useLingui();
	const { logo, siteName, loginLogos } = useAdminBranding();
	const providers = useAuthProviderList().filter((provider) => provider.LoginButton);
	const companies =
		accessHelp && loginLogos && loginLogos.length > 1
			? new Intl.ListFormat(i18n.locale, { style: "long", type: "conjunction" }).format(
					loginLogos.map((company) => company.name),
				)
			: null;

	return (
		<div className="flex min-h-screen items-center justify-center bg-kumo-base p-4">
			<div className="w-full max-w-sm">
				<div className="mb-8 text-center">
					<SignInLogo
						logoUrl={logo}
						siteName={siteName}
						logos={loginLogos}
						className="mx-auto mb-2 h-10"
					/>
					<h1 className="text-2xl font-semibold text-kumo-default">{title}</h1>
					<p className="mt-2 text-sm text-kumo-subtle">{description}</p>
					{companies && (
						<p className="mt-3 text-xs leading-relaxed text-kumo-subtle">{companies}</p>
					)}
				</div>
				{error && (
					<div
						role="alert"
						className="mb-6 rounded-lg border border-kumo-danger/20 bg-kumo-danger/10 p-4 text-sm text-kumo-danger"
					>
						{error}
					</div>
				)}
				<div className="rounded-xl border bg-kumo-base p-6 shadow-sm">
					{providers.length > 0 ? (
						<div className="grid gap-3">
							{providers.map((provider) => {
								const Button = provider.LoginButton!;
								return <Button key={provider.id} />;
							})}
							{accessHelp && (
								<p className="text-center text-xs text-kumo-subtle">
									{t`Use the account your invitation was sent to.`}
								</p>
							)}
						</div>
					) : (
						<p className="text-sm text-kumo-subtle">
							{t`No sign-in provider is configured. Add one to authProviders in the EmDash config.`}
						</p>
					)}
				</div>
				{accessHelp && (
					<details className="mt-6 text-sm text-kumo-subtle">
						<summary className="cursor-pointer text-center text-kumo-default">{t`Can't sign in?`}</summary>
						<ul className="mt-3 list-disc space-y-2 ps-5">
							<li>{t`You need an invitation. Ask your administrator to add your email address; you can sign in as soon as they have.`}</li>
							<li>{t`Sign in with the same account the invitation was sent to. If your browser picks another account, choose "Use another account".`}</li>
							<li>{t`Invitation links expire after 7 days, but you don't need the link: signing in here with the invited account works while the invitation is pending.`}</li>
							<li>{t`If you could sign in before and can't now, your access may have been removed. Ask your administrator.`}</li>
						</ul>
					</details>
				)}
			</div>
		</div>
	);
}
