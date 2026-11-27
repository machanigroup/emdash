import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { EditorPreviewPane } from "../../src/components/EditorPreviewPane";
import { render } from "../utils/render.tsx";

function Harness({ resolveUrl, version }: { resolveUrl: () => Promise<string>; version: string }) {
	return (
		<div style={{ display: "flex", height: 600 }}>
			<EditorPreviewPane
				id="preview"
				resolveUrl={resolveUrl}
				version={version}
				onClose={() => {}}
			/>
		</div>
	);
}

describe("EditorPreviewPane", () => {
	it("shows the signed preview, with the address but not the token", async () => {
		const resolveUrl = vi.fn(async () => "https://site.example/stories/launch?_preview=token-1");
		const screen = await render(<Harness resolveUrl={resolveUrl} version="rev-1" />);

		const frame = screen.getByTitle("Preview of this entry");
		await expect
			.element(frame)
			.toHaveAttribute("src", "https://site.example/stories/launch?_preview=token-1");
		await expect.element(screen.getByText("site.example/stories/launch")).toBeVisible();
	});

	it("reloads with a fresh preview URL after a save", async () => {
		let n = 0;
		const resolveUrl = vi.fn(
			async () => `https://site.example/stories/launch?_preview=token-${++n}`,
		);
		const screen = await render(<Harness resolveUrl={resolveUrl} version="rev-1" />);
		const frame = screen.getByTitle("Preview of this entry");
		await expect.element(frame).toHaveAttribute("src", expect.stringContaining("token-1"));

		await screen.rerender(<Harness resolveUrl={resolveUrl} version="rev-2" />);
		await expect.element(frame).toHaveAttribute("src", expect.stringContaining("token-2"));
		expect(resolveUrl).toHaveBeenCalledTimes(2);
	});

	it("says so when the preview can't be loaded", async () => {
		const resolveUrl = vi.fn(async () => {
			throw new Error("nope");
		});
		const screen = await render(<Harness resolveUrl={resolveUrl} version="rev-1" />);
		await expect.element(screen.getByRole("alert")).toHaveTextContent(/couldn’t be loaded/);
	});
});
