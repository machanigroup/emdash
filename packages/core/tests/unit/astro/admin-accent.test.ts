import { describe, expect, it } from "vitest";

import { adminAccentCss } from "../../../src/astro/admin-accent.js";

describe("adminAccentCss", () => {
	it("recolours the brand fill, its hover and links", () => {
		const css = adminAccentCss("#115b78");
		expect(css).toContain("--color-kumo-brand: #115b78;");
		expect(css).toContain("--color-kumo-brand-hover:");
		expect(css).toContain("--text-color-kumo-link: light-dark(");
	});

	it("accepts short hex colours", () => {
		expect(adminAccentCss("#1a7")).toContain("--color-kumo-brand: #1a7;");
	});

	it.each([
		undefined,
		"",
		"teal",
		"#12345",
		"rgb(0 0 0)",
		"#115b78; } body { display: none",
		"#115b78</style>",
	])("writes nothing for %j", (color) => {
		expect(adminAccentCss(color)).toBeNull();
	});
});
