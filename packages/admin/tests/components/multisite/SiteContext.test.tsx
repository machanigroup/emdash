import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../../../dist/styles.css";
import { SiteContext } from "../../../src/components/multisite/SiteContext";
import { render } from "../../utils/render";

const api = vi.hoisted(() => ({ fetchManifest: vi.fn(), fetchSwitcherSites: vi.fn() }));

vi.mock("../../../src/lib/api", async () => ({
	...(await vi.importActual<object>("../../../src/lib/api")),
	...api,
}));

const logo = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'/>`;

const sites = [
	{
		id: "homes",
		name: "Svasa Homes",
		orgId: "s",
		orgName: "Svasa",
		role: 50,
		url: "https://svasahomes.com",
	},
	{
		id: "life",
		name: "Svasa Life",
		orgId: "s",
		orgName: "Svasa",
		role: 50,
		url: "https://www.svasalife.com",
		logoUrl: logo,
	},
];

function renderContext() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<SiteContext />
			<p>page</p>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	api.fetchSwitcherSites.mockResolvedValue(sites);
});

describe("SiteContext", () => {
	it("names the site being edited, with its logo and domain", async () => {
		api.fetchManifest.mockResolvedValue({ multiSite: { siteId: "life", orgId: "s" } });
		const screen = await renderContext();
		const context = screen.getByTestId("site-context");
		await expect.element(context).toHaveTextContent("Editing Svasa Life");
		await expect.element(context).toHaveTextContent("svasalife.com");
		expect(context.element().querySelector("img")?.getAttribute("src")).toBe(logo);
	});

	it("shows nothing outside multi-site mode", async () => {
		api.fetchManifest.mockResolvedValue({});
		const screen = await renderContext();
		await expect.element(screen.getByText("page")).toBeInTheDocument();
		await expect.element(screen.getByTestId("site-context")).not.toBeInTheDocument();
		expect(api.fetchSwitcherSites).not.toHaveBeenCalled();
	});
});
