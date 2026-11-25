import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { AuthProviderProvider } from "../../../src/lib/auth-provider-context";
import { render } from "../../utils/render.tsx";

vi.mock("../../../src/lib/api", async () => ({
	...(await vi.importActual<object>("../../../src/lib/api")),
	fetchAuthMode: vi.fn(async () => ({ authMode: "passkey", providersOnly: true })),
}));

Object.defineProperty(window, "PublicKeyCredential", {
	value: function PublicKeyCredential() {},
	writable: true,
});

const { LoginPage } = await import("../../../src/components/LoginPage");

const google = {
	id: "google",
	label: "Google",
	LoginButton: () => <button type="button">Continue with Google</button>,
};

describe("LoginPage on a multi-site admin host", () => {
	it("offers only the sign-in providers", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const screen = await render(
			<QueryClientProvider client={qc}>
				<AuthProviderProvider authProviders={{ google }}>
					<LoginPage />
				</AuthProviderProvider>
			</QueryClientProvider>,
		);

		await expect
			.element(screen.getByRole("button", { name: "Continue with Google" }))
			.toBeVisible();
		await expect
			.element(screen.getByText("Use your organization account to continue."))
			.toBeVisible();
		expect(screen.getByText("Sign in with Passkey").query()).toBeNull();
		expect(screen.getByText("Sign in with email link").query()).toBeNull();
	});
});
