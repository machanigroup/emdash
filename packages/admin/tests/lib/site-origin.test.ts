import { describe, expect, it } from "vitest";

import { onSiteOrigin } from "../../src/lib/site-origin";

describe("onSiteOrigin", () => {
	it("puts a root-relative path on the site's origin", () => {
		expect(onSiteOrigin("/stories/launch?_preview=abc", "https://example.com")).toBe(
			"https://example.com/stories/launch?_preview=abc",
		);
	});

	it("leaves the path alone when the admin and the site share an origin", () => {
		expect(onSiteOrigin("/stories/launch", null)).toBe("/stories/launch");
	});

	it("leaves absolute and protocol-relative URLs alone", () => {
		expect(onSiteOrigin("https://other.example/a", "https://example.com")).toBe(
			"https://other.example/a",
		);
		expect(onSiteOrigin("//evil.example/a", "https://example.com")).toBe("//evil.example/a");
	});
});
