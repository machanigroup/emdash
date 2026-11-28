import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PublishWebhookResult } from "../../src/components/PublishWebhookResult";
import { render } from "../utils/render";

const api = vi.hoisted(() => ({
	fetchPublishWebhookStatus: vi.fn(),
	retryPublishWebhook: vi.fn(),
}));

vi.mock("../../src/lib/api/publish-webhook", async () => ({
	...(await vi.importActual<object>("../../src/lib/api/publish-webhook")),
	...api,
}));

const delivered = {
	id: "d1",
	timestamp: "2026-11-28T10:00:00.000Z",
	status: "success",
	httpStatus: 200,
	error: null,
	host: "hooks.example.com",
};
const refused = { ...delivered, id: "d2", status: "failed", httpStatus: 502, error: "HTTP 502" };

function renderResult(props: Partial<React.ComponentProps<typeof PublishWebhookResult>> = {}) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const element = (extra: Partial<React.ComponentProps<typeof PublishWebhookResult>> = {}) => (
		<QueryClientProvider client={queryClient}>
			<PublishWebhookResult
				collection="posts"
				entryId="e1"
				isLive
				publishToken={0}
				liveUrl="https://www.tresamotors.com/posts/hello"
				{...props}
				{...extra}
			/>
		</QueryClientProvider>
	);
	return { element, queryClient };
}

beforeEach(() => vi.clearAllMocks());

describe("PublishWebhookResult", () => {
	it("links to the live entry when the site answered", async () => {
		api.fetchPublishWebhookStatus.mockResolvedValue({ configured: true, delivery: delivered });
		const { element } = renderResult();
		const screen = await render(element());
		const link = screen.getByRole("link", { name: "Live on tresamotors.com" });
		await expect.element(link).toHaveAttribute("href", "https://www.tresamotors.com/posts/hello");
	});

	it("says the site didn't answer and resends on retry", async () => {
		api.fetchPublishWebhookStatus.mockResolvedValue({ configured: true, delivery: refused });
		api.retryPublishWebhook.mockResolvedValue({ configured: true, delivery: delivered });
		const { element } = renderResult();
		const screen = await render(element());
		await expect.element(screen.getByText("Site didn't answer (502)")).toBeInTheDocument();

		await screen.getByRole("button", { name: "Retry" }).click();

		expect(api.retryPublishWebhook).toHaveBeenCalledWith("posts", "e1");
		await expect
			.element(screen.getByRole("link", { name: "Live on tresamotors.com" }))
			.toBeInTheDocument();
	});

	it("waits for the new answer after publishing", async () => {
		api.fetchPublishWebhookStatus.mockResolvedValue({ configured: true, delivery: refused });
		const { element } = renderResult();
		const screen = await render(element());
		await expect.element(screen.getByText("Site didn't answer (502)")).toBeInTheDocument();

		api.fetchPublishWebhookStatus.mockResolvedValue({ configured: true, delivery: refused });
		await screen.rerender(element({ publishToken: 1 }));
		await expect.element(screen.getByText("Updating the live site…")).toBeInTheDocument();

		api.fetchPublishWebhookStatus.mockResolvedValue({ configured: true, delivery: delivered });
		await expect
			.element(screen.getByRole("link", { name: "Live on tresamotors.com" }))
			.toBeInTheDocument();
	});

	it("shows nothing when the site sends no publish webhook", async () => {
		api.fetchPublishWebhookStatus.mockResolvedValue({ configured: false, delivery: null });
		const { element } = renderResult();
		const screen = await render(element());
		await vi.waitFor(() => expect(api.fetchPublishWebhookStatus).toHaveBeenCalled());
		await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
	});
});
