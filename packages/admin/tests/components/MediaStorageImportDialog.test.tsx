import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { MediaStorageImportDialog } from "../../src/components/MediaStorageImportDialog";
import { importMediaFromStorage, scanMediaStorage } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api")>()),
	scanMediaStorage: vi.fn(),
	importMediaFromStorage: vi.fn(),
}));

const scan = vi.mocked(scanMediaStorage);
const importFiles = vi.mocked(importMediaFromStorage);

const items = [
	{
		key: "products/chair.png",
		filename: "chair.png",
		mimeType: "image/png",
		size: 2048,
		directory: "products",
	},
	{
		key: "products/table.jpg",
		filename: "table.jpg",
		mimeType: "image/jpeg",
		size: 4096,
		directory: "products",
	},
	{
		key: "brochure.pdf",
		filename: "brochure.pdf",
		mimeType: "application/pdf",
		size: 1024,
		directory: null,
	},
];

async function renderDialog(onImported = vi.fn()) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const screen = await render(
		<MediaStorageImportDialog open onClose={vi.fn()} onImported={onImported} />,
		{
			wrapper: ({ children }) => (
				<Toasty>
					<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
				</Toasty>
			),
		},
	);
	return { screen, onImported };
}

describe("MediaStorageImportDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		scan.mockResolvedValue({ items, scannedCount: 12 });
		importFiles.mockImplementation(async ({ keys }) => ({ imported: keys, skipped: [] }));
	});

	it("scans with the prefix and exclusions, then adds only the files left selected", async () => {
		const { screen, onImported } = await renderDialog();
		await userEvent.fill(screen.getByLabelText("Folder or prefix"), "products/");
		await userEvent.fill(screen.getByLabelText("Leave out"), "frames/\n*-640.webp\n");
		await screen.getByRole("button", { name: "Scan storage" }).click();

		expect(scan).toHaveBeenCalledWith({
			prefix: "products/",
			exclude: ["frames/", "*-640.webp"],
			cursor: undefined,
			limit: 100,
		});
		await expect
			.element(screen.getByRole("status"))
			.toHaveTextContent("Checked 12 objects. 3 files are not in the library.");
		await expect.element(screen.getByRole("button", { name: "Add 3 files" })).toBeEnabled();

		await screen.getByRole("checkbox", { name: /brochure\.pdf/ }).click();
		await screen
			.getByRole("checkbox", { name: "Put each file in a folder named after its path" })
			.click();
		await screen.getByRole("button", { name: "Add 2 files" }).click();

		expect(importFiles).toHaveBeenCalledWith({
			keys: ["products/chair.png", "products/table.jpg"],
			folder: { mode: "none" },
			exclude: ["frames/", "*-640.webp"],
		});
		await expect.element(screen.getByText("Added 2 files to the library")).toBeInTheDocument();
		expect(onImported).toHaveBeenCalledWith({
			imported: ["products/chair.png", "products/table.jpg"],
			skipped: [],
		});
		await expect
			.element(screen.getByRole("checkbox", { name: /chair\.png/ }))
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole("checkbox", { name: /brochure\.pdf/ }))
			.toBeInTheDocument();
	});

	it("continues a scan from where the last page stopped", async () => {
		scan.mockResolvedValueOnce({
			items: items.slice(0, 1),
			scannedCount: 100,
			nextCursor: "page-2",
		});
		scan.mockResolvedValueOnce({ items: items.slice(1), scannedCount: 40 });
		const { screen } = await renderDialog();
		await screen.getByRole("button", { name: "Scan storage" }).click();
		await expect
			.element(screen.getByRole("status"))
			.toHaveTextContent("Checked 100 objects so far. 1 file is not in the library.");

		await screen.getByRole("button", { name: "Scan more" }).click();

		expect(scan).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2" }));
		await expect
			.element(screen.getByRole("status"))
			.toHaveTextContent("Checked 140 objects. 3 files are not in the library.");
		await expect.element(screen.getByRole("button", { name: "Add 3 files" })).toBeEnabled();
		await expect.element(screen.getByRole("button", { name: "Scan more" })).not.toBeInTheDocument();
	});
});
