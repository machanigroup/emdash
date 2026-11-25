/**
 * Sign-in card for the shared admin of a multi-site deployment, where people
 * sign in only through the configured providers, such as Google.
 */

import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useAdminBranding } from "../../lib/admin-branding-context";
import { useAuthProviderList } from "../../lib/auth-provider-context";
import { BrandLogo } from "../Logo.js";

export function ProviderSignIn({
	title,
	description,
	error,
}: {
	title: string;
	description: React.ReactNode;
	error?: string | null;
}) {
	const { t } = useLingui();
	const { logo, siteName } = useAdminBranding();
	const providers = useAuthProviderList().filter((provider) => provider.LoginButton);

	return (
		<div className="min-h-screen flex items-center justify-center bg-kumo-base p-4">
			<div className="w-full max-w-md">
				<div className="text-center mb-8">
					<BrandLogo logoUrl={logo} siteName={siteName} className="h-10 mx-auto mb-2" />
					<h1 className="text-2xl font-semibold text-kumo-default">{title}</h1>
					<p className="mt-2 text-sm text-kumo-subtle">{description}</p>
				</div>
				{error && (
					<div
						role="alert"
						className="mb-6 rounded-lg bg-kumo-danger/10 border border-kumo-danger/20 p-4 text-sm text-kumo-danger"
					>
						{error}
					</div>
				)}
				<div className="bg-kumo-base border rounded-lg shadow-sm p-6">
					{providers.length > 0 ? (
						<div className="grid gap-3">
							{providers.map((provider) => {
								const Button = provider.LoginButton!;
								return <Button key={provider.id} />;
							})}
						</div>
					) : (
						<p className="text-sm text-kumo-subtle">
							{t`No sign-in provider is configured. Add one to authProviders in the EmDash config.`}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
