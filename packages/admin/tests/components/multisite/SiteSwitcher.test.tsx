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

const svgLogo = (width: number, height: number) =>
	`data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'/>`;

const sites = [
	{
		id: "site-a",
		name: "Brand A",
		orgId: "o",
		orgName: "Acme",
		role: 50,
		url: "https://www.a.example",
		logoUrl: svgLogo(120, 40),
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
	{
		id: "site-s",
		name: "Svasa Homes",
		orgId: "s",
		orgName: " svasa homes ",
		role: 50,
		url: "https://svasahomes.com",
		logoUrl: "https://broken.invalid/logo.png",
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

	it("names a one-site organization only once when the site has the organization's name", async () => {
		const screen = await renderSwitcher("site-a");
		await screen.getByRole("button", { name: "Switch site, current: Brand A" }).click();
		const row = screen.getByRole("menuitem", { name: /Svasa Homes/ });
		await expect.element(row).toHaveTextContent("svasahomes.com");
		expect(
			screen
				.getByRole("menu")
				.getByText(/svasa homes/i)
				.elements(),
		).toHaveLength(1);
		await expect
			.element(screen.getByRole("group", { name: /svasa homes/i }))
			.not.toBeInTheDocument();
	});

	it("heads an organization with several sites, or one whose site has another name", async () => {
		const screen = await renderSwitcher("site-a");
		await screen.getByRole("button", { name: "Switch site, current: Brand A" }).click();
		await expect.element(screen.getByRole("group", { name: "Acme" })).toBeInTheDocument();
		await expect.element(screen.getByRole("group", { name: "Azara" })).toBeInTheDocument();
	});

	it("shows each site's logo on a square tile, or its initial when it has no logo that loads", async () => {
		const screen = await renderSwitcher("site-a");
		await screen.getByRole("button", { name: "Switch site, current: Brand A" }).click();

		const brandA = screen.getByRole("menuitem", { name: /Brand A/ });
		await expect.element(brandA).toBeVisible();
		const image = brandA.element().querySelector("img");
		expect(image?.getAttribute("alt")).toBe("");
		expect([image?.offsetWidth, image?.offsetHeight]).toEqual([32, 32]);

		for (const [name, initial] of [
			[/Brand B/, "B"],
			[/Svasa Homes/, "S"],
		] as const) {
			const fallback = screen.getByRole("menuitem", { name }).getByTestId("site-logo-fallback");
			await expect.element(fallback).toHaveTextContent(initial);
			await expect.element(fallback).toHaveAttribute("aria-hidden", "true");
			const tile = fallback.element() as HTMLElement;
			expect([tile.offsetWidth, tile.offsetHeight]).toEqual([32, 32]);
		}
	});

	it("marks the site being managed with a check", async () => {
		const screen = await renderSwitcher("site-b");
		await screen.getByRole("button", { name: "Switch site, current: Brand B" }).click();
		const current = screen.getByRole("menuitem", { name: /Brand B/ });
		const other = screen.getByRole("menuitem", { name: /Brand A/ });
		await expect.element(current).toHaveAttribute("aria-current", "true");
		await expect.element(other).not.toHaveAttribute("aria-current");
		expect(current.element().querySelectorAll("svg")).toHaveLength(1);
		expect(other.element().querySelectorAll("svg")).toHaveLength(0);

		await current.click();
		expect(api.switchToSite).not.toHaveBeenCalled();
	});

	it("asks for a site when the admin shows the control plane", async () => {
		const screen = await renderSwitcher(null);
		await expect
			.element(screen.getByRole("button", { name: "Switch site, current: Choose a site" }))
			.toBeInTheDocument();
	});

	it("shows the deployment's logo on a wide light tile beside the site", async () => {
		const logo =
			"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='260' height='100'/>";
		const screen = await renderSwitcher("site-a", { logoUrl: logo, brandName: "Acme Group" });
		const image = screen.getByRole("img", { name: "Acme Group" });
		await expect.element(image).toBeVisible();
		const { width, height } = image.element().getBoundingClientRect();
		expect(height).toBe(32);
		expect(width).toBeGreaterThan(height * 2);
		expect(getComputedStyle(image.element()).backgroundColor).toBe("rgb(255, 255, 255)");
	});
});
