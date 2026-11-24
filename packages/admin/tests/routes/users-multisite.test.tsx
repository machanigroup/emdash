import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import { UsersPage } from "../../src/routes/users";
import { render } from "../utils/render";

const api = vi.hoisted(() => ({
	fetchManifest: vi.fn(),
	fetchUsers: vi.fn(),
}));

vi.mock("../../src/lib/api", async () => ({
	...(await vi.importActual<object>("../../src/lib/api")),
	...api,
}));
vi.mock("@tanstack/react-router", async () => ({
	...(await vi.importActual<object>("@tanstack/react-router")),
	Link: ({
		children,
		to,
		params,
		...props
	}: Record<string, unknown> & {
		children: React.ReactNode;
		to: string;
		params?: { orgId: string };
	}) => (
		<a href={params ? to.replace("$orgId", params.orgId) : to} {...props}>
			{children}
		</a>
	),
}));

const ravi = {
	id: "u-ravi",
	email: "ravi@example.com",
	name: "Ravi",
	avatarUrl: null,
	role: 40,
	emailVerified: true,
	disabled: false,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	lastLogin: null,
	credentialCount: 0,
	oauthProviders: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	api.fetchUsers.mockResolvedValue({ items: [ravi] });
});

async function renderPage() {
	return render(
		<Toasty>
			<UsersPage />
		</Toasty>,
	);
}

describe("UsersPage on a site of a multi-site deployment", () => {
	it("lists the site's people read-only and sends changes to the organization", async () => {
		api.fetchManifest.mockResolvedValue({ multiSite: { siteId: "site-a", orgId: "org-1" } });
		const screen = await renderPage();

		await expect.element(screen.getByText("People are managed by the organization")).toBeVisible();
		await expect.element(screen.getByText("Ravi", { exact: true })).toBeVisible();
		await expect
			.element(screen.getByRole("link", { name: "Manage members" }))
			.toHaveAttribute("href", "/organizations/org-1");
		expect(screen.getByRole("button", { name: "Invite User" }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Ravi" }).query()).toBeNull();
	});

	it("keeps invitations and editing for a single-site deployment", async () => {
		api.fetchManifest.mockResolvedValue({});
		const screen = await renderPage();

		await expect.element(screen.getByRole("button", { name: "Invite User" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Ravi" })).toBeVisible();
		expect(screen.getByText("People are managed by the organization").query()).toBeNull();
	});
});
