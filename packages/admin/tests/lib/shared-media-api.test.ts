import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSharedMedia, sharedItemToMediaItem } from "../../src/lib/api/shared-media.js";

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.href : input.url;
}

describe("shared media API", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads another site's media and picks it as an external image by its absolute URL", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				success: true,
				data: {
					items: [
						{
							id: "01MEDIA",
							filename: "beach.jpg",
							mimeType: "image/jpeg",
							url: "https://media.example.com/svasa-life/01MEDIA.jpg",
							size: 2048,
							width: 1200,
							height: 800,
							alt: "Beach at dusk",
							caption: null,
							blurhash: null,
							dominantColor: "#336699",
							site: { id: "site/svasa", name: "Svasa Life" },
						},
					],
					nextCursor: "next",
				},
			}),
		);

		const page = await fetchSharedMedia("site/svasa", {
			cursor: "after",
			limit: 12,
			search: "  beach ",
			mimeType: ["image/"],
		});

		const url = new URL(requestUrl(fetch.mock.calls[0]![0]), window.location.origin);
		expect(url.pathname).toBe("/_emdash/api/multisite/sites/site%2Fsvasa/media");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			cursor: "after",
			limit: "12",
			mimeType: "image/",
			q: "beach",
		});
		expect(page.nextCursor).toBe("next");

		const picked = sharedItemToMediaItem(page.items[0]!);
		expect(picked).toMatchObject({
			id: "",
			provider: "external",
			url: "https://media.example.com/svasa-life/01MEDIA.jpg",
			filename: "beach.jpg",
			alt: "Beach at dusk",
			width: 1200,
			height: 800,
			dominantColor: "#336699",
		});
		expect(picked.caption).toBeUndefined();
	});
});
