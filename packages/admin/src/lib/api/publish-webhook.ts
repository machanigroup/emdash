/**
 * The publish webhook result the webhook notifier plugin records for an entry
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

export const WEBHOOK_PLUGIN_ID = "webhook-notifier";

const BASE = `${API_BASE}/plugins/${WEBHOOK_PLUGIN_ID}`;

export interface PublishDelivery {
	id: string;
	timestamp: string;
	status: "success" | "failed";
	httpStatus: number | null;
	error: string | null;
	/** Host of the webhook endpoint. */
	host: string;
}

export interface PublishWebhookStatus {
	/** Whether the site sends a webhook when content is published. */
	configured: boolean;
	/** The latest publish delivery for the entry. */
	delivery: PublishDelivery | null;
}

function post(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

export async function fetchPublishWebhookStatus(id: string): Promise<PublishWebhookStatus> {
	const response = await apiFetch(`${BASE}/publish-status`, post({ id }));
	return parseApiResponse(response, i18n._(msg`Failed to load the live site's answer`));
}

export async function retryPublishWebhook(
	collection: string,
	id: string,
): Promise<PublishWebhookStatus> {
	const response = await apiFetch(`${BASE}/publish-retry`, post({ collection, id }));
	return parseApiResponse(response, i18n._(msg`Failed to notify the live site`));
}
