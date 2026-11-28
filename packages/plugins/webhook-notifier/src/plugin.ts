/**
 * Sandbox Entry Point -- Webhook Notifier
 *
 * Canonical plugin implementation using the standard format.
 * Runs in both trusted (in-process) and sandboxed (isolate) modes.
 */

import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

interface WebhookPayload {
	event: string;
	timestamp: string;
	collection?: string;
	resourceId: string;
	resourceType: "content" | "media";
	data?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

// ── SSRF protection ──

const IPV6_BRACKET_PATTERN = /^\[|\]$/g;
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "[::1]"]);
const PRIVATE_RANGES = [
	{ start: (127 << 24) >>> 0, end: ((127 << 24) | 0x00ffffff) >>> 0 },
	{ start: (10 << 24) >>> 0, end: ((10 << 24) | 0x00ffffff) >>> 0 },
	{
		start: ((172 << 24) | (16 << 16)) >>> 0,
		end: ((172 << 24) | (31 << 16) | 0xffff) >>> 0,
	},
	{
		start: ((192 << 24) | (168 << 16)) >>> 0,
		end: ((192 << 24) | (168 << 16) | 0xffff) >>> 0,
	},
	{
		start: ((169 << 24) | (254 << 16)) >>> 0,
		end: ((169 << 24) | (254 << 16) | 0xffff) >>> 0,
	},
	{ start: 0, end: 0x00ffffff },
];

function validateWebhookUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Invalid webhook URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Webhook URL scheme '${parsed.protocol}' is not allowed`);
	}
	const hostname = parsed.hostname.replace(IPV6_BRACKET_PATTERN, "");
	if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
		throw new Error("Webhook URLs targeting internal hosts are not allowed");
	}
	const parts = hostname.split(".");
	if (parts.length === 4) {
		const nums = parts.map(Number);
		if (nums.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
			const ip = ((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0;
			if (PRIVATE_RANGES.some((r) => ip >= r.start && ip <= r.end)) {
				throw new Error("Webhook URLs targeting private IP addresses are not allowed");
			}
		}
	}
	if (
		hostname === "::1" ||
		hostname.startsWith("fe80:") ||
		hostname.startsWith("fc") ||
		hostname.startsWith("fd")
	) {
		throw new Error("Webhook URLs targeting internal addresses are not allowed");
	}
}

// ── Webhook delivery ──

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type LogFn = PluginContext["log"];

async function sendWebhook(
	fetchFn: FetchFn,
	log: LogFn,
	url: string,
	payload: WebhookPayload,
	token: string | undefined,
	maxRetries: number,
): Promise<{ success: boolean; status?: number; error?: string }> {
	validateWebhookUrl(url);

	let lastError: string | undefined;
	let lastStatus: number | undefined;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"X-EmDash-Event": payload.event,
			};
			if (token) headers["Authorization"] = `Bearer ${token}`;

			const response = await fetchFn(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
			});

			lastStatus = response.status;
			if (response.ok) {
				log.info(`Delivered ${payload.event} to ${url} (${response.status})`);
				return { success: true, status: response.status };
			}

			lastError = `HTTP ${response.status}: ${response.statusText}`;
			log.warn(`Attempt ${attempt}/${maxRetries} failed: ${lastError}`);
		} catch (error) {
			lastError = error instanceof Error ? error.message : "Unknown error";
			log.warn(`Attempt ${attempt}/${maxRetries} failed: ${lastError}`);
		}

		if (attempt < maxRetries) {
			await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
		}
	}

	log.error(`Failed to deliver ${payload.event} after ${maxRetries} attempts`);
	return { success: false, status: lastStatus, error: lastError };
}

// ── Helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const v = value[key];
	return typeof v === "string" ? v : undefined;
}

const MAX_RETRIES = 3;
const MAX_DELIVERY_RECORDS = 500;
// D1 rejects a statement with more than 100 bound parameters, and deleteMany
// binds plugin_id and collection alongside the ids.
const PRUNE_BATCH_SIZE = 50;

async function getConfig(ctx: PluginContext) {
	const url = await ctx.kv.get<string>("settings:webhookUrl");
	const token = await ctx.kv.get<string>("settings:secretToken");
	const enabled = await ctx.kv.get<boolean>("settings:enabled");
	const events = await ctx.kv.get<string>("settings:events");
	const includeData = await ctx.kv.get<boolean>("settings:includeData");
	return { url, token, enabled, events, includeData };
}

function getFetchFn(ctx: PluginContext): FetchFn {
	if (!ctx.http) {
		throw new Error("Webhook notifier requires network:request capability");
	}
	return ctx.http.fetch;
}

interface DeliveryRecord {
	timestamp: string;
	webhookUrl: string;
	event: string;
	resourceId: string;
	status: "success" | "failed";
	httpStatus?: number;
	error?: string;
	durationMs: number;
}

async function deliver(
	ctx: PluginContext,
	url: string,
	token: string | null,
	payload: WebhookPayload,
): Promise<StoredDelivery> {
	const start = Date.now();
	let result: Awaited<ReturnType<typeof sendWebhook>>;
	try {
		result = await sendWebhook(
			getFetchFn(ctx),
			ctx.log,
			url,
			payload,
			token ?? undefined,
			MAX_RETRIES,
		);
	} catch (error) {
		result = { success: false, error: error instanceof Error ? error.message : String(error) };
	}

	const record: DeliveryRecord = {
		timestamp: payload.timestamp,
		webhookUrl: url,
		event: payload.event,
		resourceId: payload.resourceId,
		status: result.success ? "success" : "failed",
		httpStatus: result.status,
		error: result.error,
		durationMs: Date.now() - start,
	};
	return { id: await recordDelivery(ctx, record), ...record };
}

async function recordDelivery(ctx: PluginContext, record: DeliveryRecord): Promise<string> {
	const deliveries = ctx.storage.deliveries!;
	const id = crypto.randomUUID();
	await deliveries.put(id, record);

	// Re-count after every batch: the excess can span several batches, and a
	// concurrent delivery can insert between the count and the delete.
	for (;;) {
		const excess = (await deliveries.count()) - MAX_DELIVERY_RECORDS;
		if (excess <= 0) return id;
		const oldest = await deliveries.query({
			orderBy: { timestamp: "asc" },
			limit: Math.min(excess, PRUNE_BATCH_SIZE),
		});
		if (oldest.items.length === 0) return id;
		await deliveries.deleteMany(oldest.items.map((item) => item.id));
	}
}

interface StoredDelivery extends DeliveryRecord {
	id: string;
}

type Config = Awaited<ReturnType<typeof getConfig>>;

/** Publishing and unpublishing change what the site shows, so every content setting sends them. */
function sendsStateChanges(config: Config): config is Config & { url: string } {
	return config.enabled !== false && !!config.url && config.events !== "media";
}

function stateChangePayload(
	name: "content:publish" | "content:unpublish",
	collection: string,
	content: Record<string, unknown>,
	includeData: boolean | null | undefined,
): WebhookPayload {
	const id = content.id;
	return {
		event: name,
		timestamp: new Date().toISOString(),
		collection,
		resourceId: typeof id === "string" ? id : String(id),
		resourceType: "content",
		data: includeData && isRecord(content.data) ? content.data : undefined,
		metadata: { slug: content.slug, status: content.status },
	};
}

async function sendStateChange(
	name: "content:publish" | "content:unpublish",
	event: { content: Record<string, unknown>; collection: string },
	ctx: PluginContext,
): Promise<void> {
	const config = await getConfig(ctx);
	if (!sendsStateChanges(config)) return;
	const payload = stateChangePayload(name, event.collection, event.content, config.includeData);
	await deliver(ctx, config.url, config.token, payload);
}

// ── Publish results for the content editor ──

const EDITOR_ROLE = 40;

function routeError(code: string, message: string, status: number): Error {
	// Matches the host's PluginRouteError by shape, so the caller gets this status and code.
	return Object.assign(new Error(message), { name: "PluginRouteError", code, status });
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** What the editor may see of a delivery: the endpoint's host, never its full URL, which can carry a secret. */
function publicDelivery(delivery: StoredDelivery) {
	return {
		id: delivery.id,
		timestamp: delivery.timestamp,
		status: delivery.status,
		httpStatus: delivery.httpStatus ?? null,
		error: delivery.error ?? null,
		host: hostOf(delivery.webhookUrl),
	};
}

function toStoredDelivery(id: string, data: unknown): StoredDelivery | null {
	if (!isRecord(data)) return null;
	const { timestamp, webhookUrl, event, resourceId, status } = data;
	if (
		typeof timestamp !== "string" ||
		typeof webhookUrl !== "string" ||
		typeof event !== "string" ||
		typeof resourceId !== "string" ||
		(status !== "success" && status !== "failed")
	) {
		return null;
	}
	return {
		id,
		timestamp,
		webhookUrl,
		event,
		resourceId,
		status,
		httpStatus: typeof data.httpStatus === "number" ? data.httpStatus : undefined,
		error: typeof data.error === "string" ? data.error : undefined,
		durationMs: typeof data.durationMs === "number" ? data.durationMs : 0,
	};
}

async function latestPublishDelivery(
	ctx: PluginContext,
	resourceId: string,
): Promise<StoredDelivery | null> {
	const { items } = await ctx.storage.deliveries!.query({
		where: { resourceId, event: "content:publish" },
		orderBy: { timestamp: "desc" },
		limit: 1,
	});
	const latest = items[0];
	return latest ? toStoredDelivery(latest.id, latest.data) : null;
}

async function publishStatus(ctx: PluginContext, resourceId: string) {
	const config = await getConfig(ctx);
	const delivery = await latestPublishDelivery(ctx, resourceId);
	return {
		configured: sendsStateChanges(config),
		delivery: delivery ? publicDelivery(delivery) : null,
	};
}

async function retryPublish(
	ctx: PluginContext,
	collection: string,
	id: string,
	user: { id: string; role: number } | undefined,
) {
	const config = await getConfig(ctx);
	if (!sendsStateChanges(config)) {
		throw routeError("WEBHOOKS_OFF", "This site doesn't send publish webhooks", 409);
	}
	if (!ctx.content) throw routeError("CONTENT_UNAVAILABLE", "Content access is unavailable", 500);
	const content = await ctx.content.get(collection, id);
	if (!content) throw routeError("NOT_FOUND", "Content not found", 404);
	if (user && user.role < EDITOR_ROLE && content.authorId !== user.id) {
		throw routeError("FORBIDDEN", "You can only resend publishing of your own content", 403);
	}
	if (content.status !== "published") {
		throw routeError("NOT_PUBLISHED", "Only published content can be resent", 409);
	}
	const payload = stateChangePayload(
		"content:publish",
		collection,
		{ ...content },
		config.includeData,
	);
	const delivery = await deliver(ctx, config.url, config.token, payload);
	return { configured: true, delivery: publicDelivery(delivery) };
}

// ── Test calls ──

const STATUS_REASONS: Record<number, string> = {
	400: "request rejected",
	401: "token rejected",
	403: "token rejected",
	404: "no endpoint at this URL",
	405: "endpoint doesn't accept POST",
	408: "timed out",
	429: "too many requests",
};

function statusReason(status: number): string {
	return STATUS_REASONS[status] ?? (status >= 500 ? "the site had an error" : "request refused");
}

function testPayload(): WebhookPayload {
	return {
		event: "content:create",
		timestamp: new Date().toISOString(),
		resourceId: "test-" + Date.now(),
		resourceType: "content",
		metadata: { test: true, message: "Webhook test from EmDash CMS" },
	};
}

interface TestOutcome {
	ok: boolean;
	status?: number;
	error?: string;
	title: string;
	description?: string;
}

/** Sends one test call and describes the answer, as "example.com answered 200" or "401: token rejected". */
async function sendTestCall(
	ctx: PluginContext,
	url: string,
	token: string | null | undefined,
): Promise<TestOutcome> {
	const host = hostOf(url);
	let result: Awaited<ReturnType<typeof sendWebhook>>;
	try {
		result = await sendWebhook(getFetchFn(ctx), ctx.log, url, testPayload(), token ?? undefined, 1);
	} catch (error) {
		result = { success: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (result.success) {
		return { ok: true, status: result.status, title: `${host} answered ${result.status}` };
	}
	if (result.status !== undefined) {
		return {
			ok: false,
			status: result.status,
			error: result.error,
			title: `${result.status}: ${statusReason(result.status)}`,
			description: `${host} refused the test call.`,
		};
	}
	return {
		ok: false,
		error: result.error,
		title: `${host} didn't answer`,
		description: result.error ?? "Unknown error",
	};
}

function testBanner(outcome: TestOutcome) {
	return {
		type: "banner",
		variant: outcome.ok ? "default" : "error",
		title: outcome.title,
		...(outcome.description && { description: outcome.description }),
	};
}

// ── Plugin definition ──

export default {
	hooks: {
		"content:afterSave": {
			priority: 210,
			timeout: 10000,
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				const { url, token, enabled, events, includeData } = await getConfig(ctx);
				if (enabled === false || !url || events === "media" || events === "publishing") return;

				const contentId =
					typeof event.content.id === "string" ? event.content.id : String(event.content.id);

				const payload: WebhookPayload = {
					event: event.isNew ? "content:create" : "content:update",
					timestamp: new Date().toISOString(),
					collection: event.collection,
					resourceId: contentId,
					resourceType: "content",
					data: includeData && isRecord(event.content.data) ? event.content.data : undefined,
					metadata: {
						slug: event.content.slug,
						status: event.content.status,
						draftRevisionId: event.content.draftRevisionId ?? null,
					},
				};

				await deliver(ctx, url, token, payload);
			},
		},

		"content:afterDelete": {
			priority: 210,
			timeout: 10000,
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				const { url, token, enabled, events } = await getConfig(ctx);
				if (enabled === false || !url || events === "media") return;

				const payload: WebhookPayload = {
					event: "content:delete",
					timestamp: new Date().toISOString(),
					collection: event.collection,
					resourceId: event.id,
					resourceType: "content",
				};

				await deliver(ctx, url, token, payload);
			},
		},

		"content:afterPublish": {
			priority: 210,
			timeout: 10000,
			errorPolicy: "continue",
			handler: async (event, ctx) => sendStateChange("content:publish", event, ctx),
		},

		"content:afterUnpublish": {
			priority: 210,
			timeout: 10000,
			errorPolicy: "continue",
			handler: async (event, ctx) => sendStateChange("content:unpublish", event, ctx),
		},

		"media:afterUpload": {
			priority: 210,
			timeout: 10000,
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				const { url, token, enabled, events, includeData } = await getConfig(ctx);
				if (enabled === false || !url || events === "content" || events === "publishing") return;

				const payload: WebhookPayload = {
					event: "media:upload",
					timestamp: new Date().toISOString(),
					resourceId: event.media.id,
					resourceType: "media",
					data: includeData
						? {
								filename: event.media.filename,
								mimeType: event.media.mimeType,
								size: event.media.size,
							}
						: undefined,
				};

				await deliver(ctx, url, token, payload);
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx, ctx) => {
				const interaction = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					value?: string;
					values?: Record<string, unknown>;
				};

				if (interaction.type === "page_load" && interaction.page === "widget:status") {
					return buildStatusWidget(ctx);
				}
				if (interaction.type === "page_load" && interaction.page === "/settings") {
					return buildSettingsPage(ctx);
				}
				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					return saveSettings(ctx, interaction.values ?? {});
				}
				if (interaction.type === "block_action" && interaction.action_id === "test_webhook") {
					return testWebhook(ctx);
				}
				return { blocks: [] };
			},
		},

		status: {
			handler: async (_routeCtx, ctx) => {
				try {
					const url = await ctx.kv.get<string>("settings:webhookUrl");
					const enabled = await ctx.kv.get<boolean>("settings:enabled");
					const deliveries = ctx.storage.deliveries!;
					const successful = await deliveries.count({ status: "success" });
					const failed = await deliveries.count({ status: "failed" });

					return {
						configured: !!url,
						enabled: enabled ?? true,
						stats: { successful, failed },
					};
				} catch (error) {
					ctx.log.error("Failed to get status", error);
					return {
						configured: false,
						enabled: true,
						stats: { successful: 0, failed: 0 },
					};
				}
			},
		},

		settings: {
			handler: async (_routeCtx, ctx) => {
				try {
					const settings = await ctx.kv.list("settings:");
					const map: Record<string, unknown> = {};
					for (const entry of settings) {
						map[entry.key.replace("settings:", "")] = entry.value;
					}
					return {
						webhookUrl: typeof map.webhookUrl === "string" ? map.webhookUrl : "",
						enabled: typeof map.enabled === "boolean" ? map.enabled : true,
						includeData: typeof map.includeData === "boolean" ? map.includeData : false,
						events: typeof map.events === "string" ? map.events : "all",
					};
				} catch (error) {
					ctx.log.error("Failed to get settings", error);
					return { webhookUrl: "", enabled: true, includeData: false, events: "all" };
				}
			},
		},

		"settings/save": {
			handler: async (routeCtx, ctx) => {
				try {
					const input = isRecord(routeCtx.input) ? routeCtx.input : {};
					if (typeof input.webhookUrl === "string")
						await ctx.kv.set("settings:webhookUrl", input.webhookUrl);
					if (typeof input.enabled === "boolean")
						await ctx.kv.set("settings:enabled", input.enabled);
					if (typeof input.includeData === "boolean")
						await ctx.kv.set("settings:includeData", input.includeData);
					if (typeof input.events === "string") await ctx.kv.set("settings:events", input.events);
					return { success: true };
				} catch (error) {
					ctx.log.error("Failed to save settings", error);
					return { success: false, error: String(error) };
				}
			},
		},

		test: {
			handler: async (routeCtx, ctx) => {
				const testUrl = getString(routeCtx.input, "url");
				if (!testUrl) return { success: false, error: "No webhook URL provided" };

				const token = await ctx.kv.get<string>("settings:secretToken");

				const payload = testPayload();
				const result = await sendWebhook(
					getFetchFn(ctx),
					ctx.log,
					testUrl,
					payload,
					token ?? undefined,
					1,
				);
				return {
					success: result.success,
					status: result.status,
					error: result.error,
					payload,
				};
			},
		},

		"publish-status": {
			permission: "content:publish_own",
			handler: async (routeCtx, ctx) => {
				const id = getString(routeCtx.input, "id");
				if (!id) throw routeError("VALIDATION_ERROR", "An entry id is required", 400);
				return publishStatus(ctx, id);
			},
		},

		"publish-retry": {
			permission: "content:publish_own",
			handler: async (routeCtx, ctx) => {
				const collection = getString(routeCtx.input, "collection");
				const id = getString(routeCtx.input, "id");
				if (!collection || !id) {
					throw routeError("VALIDATION_ERROR", "A collection and an entry id are required", 400);
				}
				return retryPublish(ctx, collection, id, routeCtx.user);
			},
		},
	},
} satisfies SandboxedPlugin;

// ── Block Kit admin helpers ──

async function buildStatusWidget(ctx: PluginContext) {
	try {
		const url = await ctx.kv.get<string>("settings:webhookUrl");
		const enabled = await ctx.kv.get<boolean>("settings:enabled");
		const isConfigured = !!url && enabled !== false;

		let successful = 0;
		let failed = 0;
		try {
			const deliveries = ctx.storage.deliveries!;
			successful = await deliveries.count({ status: "success" });
			failed = await deliveries.count({ status: "failed" });
		} catch {
			// Storage not available yet
		}

		const blocks: unknown[] = [
			{
				type: "fields",
				fields: [
					{
						label: "Status",
						value: isConfigured ? "Active" : "Not Configured",
					},
					{
						label: "Endpoint",
						value: url ? url : "None",
					},
				],
			},
		];

		if (isConfigured) {
			blocks.push({
				type: "stats",
				items: [
					{ label: "Delivered", value: String(successful) },
					{ label: "Failed", value: String(failed) },
				],
			});
		} else {
			blocks.push({
				type: "context",
				text: "Configure a webhook URL in settings to start sending events.",
			});
		}

		return { blocks };
	} catch (error) {
		ctx.log.error("Failed to build status widget", error);
		return { blocks: [{ type: "context", text: "Failed to load webhook status" }] };
	}
}

async function buildSettingsPage(ctx: PluginContext, test?: TestOutcome) {
	try {
		const webhookUrl = (await ctx.kv.get<string>("settings:webhookUrl")) ?? "";
		const enabled = (await ctx.kv.get<boolean>("settings:enabled")) ?? true;
		const includeData = (await ctx.kv.get<boolean>("settings:includeData")) ?? false;
		const events = (await ctx.kv.get<string>("settings:events")) ?? "all";

		const payloadPreview = JSON.stringify(
			{
				event: "content:create",
				timestamp: new Date().toISOString(),
				collection: "posts",
				resourceId: "abc123",
				resourceType: "content",
				...(includeData && {
					data: { title: "Example Post" },
				}),
				metadata: { slug: "example-post", status: "published", draftRevisionId: null },
			},
			null,
			2,
		);

		return {
			blocks: [
				{ type: "header", text: "Webhook Settings" },
				{
					type: "context",
					text: "Send notifications to external services when content changes.",
				},
				...(test ? [testBanner(test)] : []),
				{ type: "divider" },
				{
					type: "form",
					block_id: "webhook-settings",
					fields: [
						{
							type: "text_input",
							action_id: "webhookUrl",
							label: "Webhook URL",
							initial_value: webhookUrl,
						},
						{
							type: "secret_input",
							action_id: "secretToken",
							label: "Secret Token",
						},
						{
							type: "toggle",
							action_id: "enabled",
							label: "Enable Webhooks",
							initial_value: enabled,
						},
						{
							type: "select",
							action_id: "events",
							label: "Events to Send",
							options: [
								{ label: "All events", value: "all" },
								{ label: "Content changes only", value: "content" },
								{ label: "Publishing only (publish, unpublish, delete)", value: "publishing" },
								{ label: "Media uploads only", value: "media" },
							],
							initial_value: events,
						},
						{
							type: "toggle",
							action_id: "includeData",
							label: "Include Content Data",
							initial_value: includeData,
						},
					],
					submit: { label: "Save Settings", action_id: "save_settings" },
				},
				{ type: "divider" },
				{ type: "section", text: "**Payload Preview**" },
				{ type: "section", text: "```json\n" + payloadPreview + "\n```" },
				{
					type: "actions",
					elements: [
						{
							type: "button",
							label: "Test Webhook",
							action_id: "test_webhook",
							style: "primary",
						},
					],
				},
			],
		};
	} catch (error) {
		ctx.log.error("Failed to build settings page", error);
		return { blocks: [{ type: "context", text: "Failed to load settings" }] };
	}
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	try {
		if (typeof values.webhookUrl === "string")
			await ctx.kv.set("settings:webhookUrl", values.webhookUrl);
		if (typeof values.secretToken === "string" && values.secretToken !== "")
			await ctx.kv.set("settings:secretToken", values.secretToken);
		if (typeof values.enabled === "boolean") await ctx.kv.set("settings:enabled", values.enabled);
		if (typeof values.events === "string") await ctx.kv.set("settings:events", values.events);
		if (typeof values.includeData === "boolean")
			await ctx.kv.set("settings:includeData", values.includeData);
	} catch (error) {
		ctx.log.error("Failed to save settings", error);
		return {
			blocks: [{ type: "banner", variant: "error", title: "Failed to save settings" }],
			toast: { message: "Failed to save settings", type: "error" },
		};
	}

	const { url, token, enabled } = await getConfig(ctx);
	const test = url && enabled !== false ? await sendTestCall(ctx, url, token) : undefined;
	return {
		...(await buildSettingsPage(ctx, test)),
		toast: test
			? {
					message: `Settings saved. Test call: ${test.title}`,
					type: test.ok ? "success" : "error",
				}
			: { message: "Settings saved", type: "success" },
	};
}

async function testWebhook(ctx: PluginContext) {
	const url = await ctx.kv.get<string>("settings:webhookUrl");
	if (!url) {
		return {
			blocks: [{ type: "banner", variant: "alert", title: "Enter a webhook URL first." }],
			toast: { message: "No webhook URL configured", type: "error" },
		};
	}

	const token = await ctx.kv.get<string>("settings:secretToken");
	const test = await sendTestCall(ctx, url, token);
	return {
		...(await buildSettingsPage(ctx, test)),
		toast: { message: test.title, type: test.ok ? "success" : "error" },
	};
}
