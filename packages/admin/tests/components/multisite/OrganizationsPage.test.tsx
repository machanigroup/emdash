import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../../dist/styles.css";
import { OrganizationsPage } from "../../../src/components/multisite/OrganizationsPage";
import { render } from "../../utils/render";

const api = vi.hoisted(() => ({
	fetchOrganizations: vi.fn(),
	createOrganization: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/api", async () => ({
	...(await vi.importActual<object>("../../../src/lib/api")),
	...api,
}));
vi.mock("@tanstack/react-router", async () => ({
	...(await vi.importActual<object>("@tanstack/react-router")),
	Link: ({
		children,
		to: _to,
		params: _params,
		...props
	}: Record<string, unknown> & { children: React.ReactNode }) => <a {...props}>{children}</a>,
	useNavigate: () => navigate,
}));

async function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<Toasty>
			<QueryClientProvider client={queryClient}>
				<OrganizationsPage />
			</QueryClientProvider>
		</Toasty>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	api.fetchOrganizations.mockResolvedValue({
		canCreate: true,
		items: [{ id: "org-1", slug: "acme", name: "Acme", role: 50, siteCount: 2, memberCount: 3 }],
	});
	api.createOrganization.mockResolvedValue({ id: "org-2" });
});

describe("OrganizationsPage", () => {
	it("lists organizations with their size and the user's role", async () => {
		const screen = await renderPage();
		await expect.element(screen.getByText("Acme")).toBeInTheDocument();
		await expect.element(screen.getByText("2 sites")).toBeInTheDocument();
		await expect.element(screen.getByText("3 members")).toBeInTheDocument();
		await expect.element(screen.getByText("Admin")).toBeInTheDocument();
	});

	it("creates an organization with a slug suggested from its name", async () => {
		const screen = await renderPage();
		await screen.getByRole("button", { name: "New organization" }).click();
		await userEvent.fill(screen.getByLabelText("Name"), "Brand Studio");
		await expect.element(screen.getByLabelText("Slug")).toHaveValue("brand-studio");
		await screen.getByRole("button", { name: "Create organization" }).click();

		await vi.waitFor(() =>
			expect(api.createOrganization).toHaveBeenCalledWith({
				name: "Brand Studio",
				slug: "brand-studio",
			}),
		);
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({
				to: "/organizations/$orgId",
				params: { orgId: "org-2" },
			}),
		);
	});

	it("hides creation from people who aren't deployment Admins", async () => {
		api.fetchOrganizations.mockResolvedValue({ canCreate: false, items: [] });
		const screen = await renderPage();
		await expect
			.element(
				screen.getByText(
					"You aren't a member of any organization yet. Ask an organization Admin to add you.",
				),
			)
			.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "New organization" }).query()).toBeNull();
	});
});
