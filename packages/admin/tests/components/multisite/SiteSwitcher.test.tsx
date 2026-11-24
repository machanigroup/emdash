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
		url: "https://a.example",
	},
	{
		id: "site-b",
		name: "Brand B",
		orgId: "o",
		orgName: "Acme",
		role: 40,
		url: "https://b.example",
	},
];

async function renderSwitcher(currentSiteId: string | null) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<SiteSwitcher currentSiteId={currentSiteId} />
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

	it("asks for a site when the admin shows the control plane", async () => {
		const screen = await renderSwitcher(null);
		await expect
			.element(screen.getByRole("button", { name: "Switch site, current: Choose a site" }))
			.toBeInTheDocument();
	});
});
