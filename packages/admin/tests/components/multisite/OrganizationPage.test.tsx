import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../../dist/styles.css";
import { OrganizationPage } from "../../../src/components/multisite/OrganizationPage";
import type { OrganizationDetail } from "../../../src/lib/api";
import { render } from "../../utils/render";

const api = vi.hoisted(() => ({
	fetchOrganization: vi.fn(),
	fetchSiteRefs: vi.fn(),
	addMember: vi.fn(),
	updateMemberRole: vi.fn(),
	removeMember: vi.fn(),
	setSiteRole: vi.fn(),
	createSite: vi.fn(),
	updateSite: vi.fn(),
	cancelInvite: vi.fn(),
	renameOrganization: vi.fn(),
	switchToSite: vi.fn(),
	createSiteSignInLink: vi.fn(),
}));

vi.mock("../../../src/lib/api", async () => ({
	...(await vi.importActual<object>("../../../src/lib/api")),
	...api,
}));

function org(overrides: Partial<OrganizationDetail> = {}): OrganizationDetail {
	return {
		id: "org-1",
		slug: "acme",
		name: "Acme",
		viewerRole: 50,
		canManageMembers: true,
		canManageSites: true,
		sites: [
			{
				id: "site-a",
				orgId: "org-1",
				slug: "brand-a",
				name: "Brand A",
				databaseRef: "brand-a",
				storageRef: null,
				status: "active",
				hostnames: ["brand-a.com"],
				primaryHostname: "brand-a.com",
				url: "https://brand-a.com",
			},
		],
		members: [
			{ userId: "u-priya", email: "priya@example.com", name: "Priya", role: 50, siteRoles: [] },
			{ userId: "u-ravi", email: "ravi@example.com", name: "Ravi", role: 40, siteRoles: [] },
		],
		invites: [{ email: "new@example.com", role: 30, createdAt: "2026-11-24T00:00:00.000Z" }],
		...overrides,
	};
}

async function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<Toasty>
			<QueryClientProvider client={queryClient}>
				<OrganizationPage orgId="org-1" />
			</QueryClientProvider>
		</Toasty>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	api.fetchOrganization.mockResolvedValue(org());
	api.fetchSiteRefs.mockResolvedValue({ databases: ["default", "brand-a"], storages: ["default"] });
	api.addMember.mockResolvedValue({ status: "invited" });
	api.updateMemberRole.mockResolvedValue(undefined);
	api.removeMember.mockResolvedValue(undefined);
	api.setSiteRole.mockResolvedValue(undefined);
});

describe("OrganizationPage", () => {
	it("lists the organization's sites, members, and pending invitations", async () => {
		const screen = await renderPage();

		await expect.element(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
		await expect.element(screen.getByText("brand-a.com")).toBeInTheDocument();
		await expect.element(screen.getByText("ravi@example.com")).toBeInTheDocument();
		await expect.element(screen.getByText("new@example.com")).toBeInTheDocument();
	});

	it("switches the admin to a site from its row", async () => {
		const screen = await renderPage();
		await screen.getByRole("button", { name: "Manage" }).click();
		expect(api.switchToSite).toHaveBeenCalledWith("site-a");
	});

	it("removes a member after confirming", async () => {
		const screen = await renderPage();
		await screen.getByRole("button", { name: "Remove Ravi" }).click();
		await expect
			.element(screen.getByRole("heading", { name: "Remove member?" }))
			.toBeInTheDocument();
		await screen.getByRole("button", { name: "Remove", exact: true }).click();

		await vi.waitFor(() => expect(api.removeMember).toHaveBeenCalledWith("org-1", "u-ravi"));
	});

	it("adds a member by email with the chosen role", async () => {
		const screen = await renderPage();
		await screen.getByRole("button", { name: "Add member" }).click();
		await userEvent.fill(screen.getByLabelText("Email"), "sam@example.com");
		await screen.getByRole("dialog").getByRole("button", { name: "Add member" }).click();

		await vi.waitFor(() =>
			expect(api.addMember).toHaveBeenCalledWith("org-1", { email: "sam@example.com", role: 30 }),
		);
		await expect
			.element(screen.getByText("Invitation saved. They join when they sign in with this email."))
			.toBeInTheDocument();
	});

	it("shows roles without controls to members who can't manage the organization", async () => {
		api.fetchOrganization.mockResolvedValue(
			org({ canManageMembers: false, canManageSites: false, viewerRole: 40, invites: [] }),
		);
		const screen = await renderPage();

		await expect.element(screen.getByText("ravi@example.com")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add member" }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Remove Ravi" }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Add site" }).query()).toBeNull();
		await expect.element(screen.getByText("Editor")).toBeInTheDocument();
	});
});
