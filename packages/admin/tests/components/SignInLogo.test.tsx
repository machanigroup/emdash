import { afterEach, describe, expect, it, vi } from "vitest";

import { SignInLogo } from "../../src/components/Logo";
import { render } from "../utils/render.tsx";

const LOGOS = [
	{ src: "/a.svg", name: "Machani Group" },
	{ src: "/b.svg", name: "Svasa Life" },
];

describe("SignInLogo", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows one company's logo at a time, then the next", async () => {
		vi.useFakeTimers();
		const screen = await render(<SignInLogo logos={LOGOS} className="h-10" />);

		await expect.element(screen.getByRole("img", { name: "Machani Group" })).toBeInTheDocument();
		await expect.element(screen.getByRole("img", { name: "Svasa Life" })).not.toBeInTheDocument();

		await vi.advanceTimersByTimeAsync(2600);

		await expect.element(screen.getByRole("img", { name: "Svasa Life" })).toBeInTheDocument();
		await expect
			.element(screen.getByRole("img", { name: "Machani Group" }))
			.not.toBeInTheDocument();
	});

	it("shows the single brand logo when no logos are listed", async () => {
		const screen = await render(
			<SignInLogo logoUrl="/brand.svg" siteName="Machani Group" className="h-10" />,
		);
		await expect
			.element(screen.getByRole("img", { name: "Machani Group" }))
			.toHaveAttribute("src", "/brand.svg");
	});
});
