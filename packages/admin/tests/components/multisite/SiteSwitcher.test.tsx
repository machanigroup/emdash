import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../../../dist/styles.css";
import { SiteSwitcher } from "../../../src/components/multisite/SiteSwitcher";
import { render } from "../../utils/render";

const api = vi.hoisted(() => ({ fetchSwitcherSites: vi.fn(), switchToSite: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/api", async () => ({
	...(await vi.importActual<object>("../../../src/lib/api")),
	...api,
}));
vi.mock("@tanstack/react-router", async () => ({
	...(await vi.importActual<object>("@tanstack/react-router")),
	useNavigate: () => navigate,
}));

const sites = [
	{
		id: "site-a",
		name: "Brand A",
		orgId: "o",
		orgName: "Acme",
		role: 50,
		url: "https://www.a.example",
	},
	{
		id: "site-b",
		name: "Brand B",
		orgId: "o",
		orgName: "Acme",
		role: 40,
		url: "https://b.example",
	},
	{
		id: "site-c",
		name: "Beach House",
		orgId: "p",
		orgName: "Azara",
		role: 50,
		url: null,
	},
];

async function renderSwitcher(
	currentSiteId: string | null,
	branding: { logoUrl?: string; brandName?: string } = {},
) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<SiteSwitcher currentSiteId={currentSiteId} {...branding} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	api.fetchSwitcherSites.mockResolvedValue(sites);
});

describe("SiteSwitcher", () => {
	it("names the site being managed and switches to another", async () => {
		const screen = await renderSwitcher("site-a");
		const trigger = screen.getByRole("button", { name: "Switch site, current: Brand A" });
		await expect.element(trigger).toBeInTheDocument();

		await trigger.click();
		await screen.getByRole("menuitem", { name: /Brand B/ }).click();

		expect(api.switchToSite).toHaveBeenCalledWith("site-b");
	});

	it("shows the domain of the site being managed and of each site in the menu", async () => {
		const screen = await renderSwitcher("site-a");
		const trigger = screen.getByRole("button", { name: "Switch site, current: Brand A" });
		await expect.element(trigger).toHaveTextContent("a.example");

		await trigger.click();
		await expect
			.element(screen.getByRole("menuitem", { name: /Brand B/ }))
			.toHaveTextContent("b.example");
		await expect
			.element(screen.getByRole("menuitem", { name: /Beach House/ }))
			.toHaveTextContent("No domain yet");
	});

	it("groups sites by organization", async () => {
		const screen = await renderSwitcher("site-c");
		await screen.getByRole("button", { name: "Switch site, current: Beach House" }).click();
		const azara = screen.getByRole("group", { name: "Azara" });
		await expect.element(azara.getByRole("menuitem", { name: /Beach House/ })).toBeInTheDocument();
		await expect.element(azara.getByRole("menuitem", { name: /Brand A/ })).not.toBeInTheDocument();
		await expect
			.element(
				screen.getByRole("group", { name: "Acme" }).getByRole("menuitem", { name: /Brand B/ }),
			)
			.toBeInTheDocument();
	});

	it("asks for a site when the admin shows the control plane", async () => {
		const screen = await renderSwitcher(null);
		await expect
			.element(screen.getByRole("button", { name: "Switch site, current: Choose a site" }))
			.toBeInTheDocument();
	});

	it("shows the deployment's logo at a readable size beside the site", async () => {
		const logo =
			"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='260' height='100'/>";
		const screen = await renderSwitcher("site-a", { logoUrl: logo, brandName: "Acme Group" });
		const image = screen.getByRole("img", { name: "Acme Group" });
		await expect.element(image).toBeVisible();
		const { width, height } = image.element().getBoundingClientRect();
		expect(height).toBe(32);
		expect(width).toBeGreaterThan(height * 2);
	});
});
