import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { AuthProviderProvider } from "../../../src/lib/auth-provider-context";
import { render } from "../../utils/render.tsx";

vi.mock("../../../src/lib/api/client", async () => ({
	...(await vi.importActual<object>("../../../src/lib/api/client")),
	apiFetch: vi.fn(async () =>
		Response.json({
			data: { needsSetup: true, multiSite: { signInDomains: ["machanigroup.com"] } },
		}),
	),
}));

const { SetupWizard } = await import("../../../src/components/SetupWizard");

const google = {
	id: "google",
	label: "Google",
	LoginButton: () => <button type="button">Continue with Google</button>,
};

describe("SetupWizard on a multi-site admin host", () => {
	it("only signs in the first administrator through a provider", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const screen = await render(
			<QueryClientProvider client={qc}>
				<AuthProviderProvider authProviders={{ google }}>
					<SetupWizard />
				</AuthProviderProvider>
			</QueryClientProvider>,
		);

		await expect
			.element(screen.getByRole("heading", { name: "Set up your organizations" }))
			.toBeVisible();
		await expect
			.element(screen.getByText(/Only accounts from machanigroup.com can sign in/))
			.toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Continue with Google" }))
			.toBeVisible();
		expect(screen.getByLabelText("Site Title").query()).toBeNull();
	});
});
