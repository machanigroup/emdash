import { afterEach, beforeEach, expect, it } from "vitest";

import { activateMediaUsageCapture } from "../../../src/media/usage/activation.js";
import { markContentMediaUsageCollectionStale } from "../../../src/media/usage/content-refresh.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const postsSeed: SeedFile = {
	version: "1",
	collections: [
		{
			slug: "posts",
			label: "Posts",
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "hero", label: "Hero", type: "image" },
			],
		},
	],
};

describeEachDialect("media usage lifecycle left by a deleted collection", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("does not recreate bookkeeping for a deleted collection when a late refresh marks it stale", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.deleteCollection("posts", { force: true });

		await markContentMediaUsageCollectionStale(ctx.db, "posts", "CONTENT_USAGE_REFRESH_ERROR");

		expect(await statusRows()).toEqual([]);

		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		await expect(applySeed(ctx.db, postsSeed)).resolves.toMatchObject({
			collections: { created: 1 },
		});
	});

	it.each([
		{ shape: "an active lifecycle", collectionId: "deleted-posts", captureState: "active" },
		{ shape: "a status row without a lifecycle", collectionId: null, captureState: null },
	])(
		"applies a seed over $shape left behind for the slug",
		async ({ collectionId, captureState }) => {
			await activateMediaUsageCapture(ctx.db, { writersDrained: true });
			await ctx.db
				.insertInto("_emdash_media_usage_index_status")
				.values({
					adapter_id: "content-media",
					scope_type: "collection",
					scope_key: "posts",
					status: "complete",
					collection_id: collectionId,
					capture_state: captureState,
					updated_at: new Date().toISOString(),
				})
				.execute();

			await expect(applySeed(ctx.db, postsSeed)).resolves.toMatchObject({
				collections: { created: 1 },
			});

			const collection = await new SchemaRegistry(ctx.db).getCollection("posts");
			expect(await statusRows()).toEqual([
				expect.objectContaining({ collection_id: collection?.id, capture_state: "active" }),
			]);
		},
	);

	it("activates capture for a collection whose slug kept a deleted collection's lifecycle", async () => {
		const collection = await new SchemaRegistry(ctx.db).createCollection({
			slug: "posts",
			label: "Posts",
		});
		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: "posts",
				status: "complete",
				collection_id: "deleted-posts",
				capture_state: "active",
				updated_at: new Date().toISOString(),
			})
			.onConflict((oc) =>
				oc
					.columns(["adapter_id", "scope_type", "scope_key"])
					.doUpdateSet({ collection_id: "deleted-posts", capture_state: "active" }),
			)
			.execute();

		await expect(activateMediaUsageCapture(ctx.db, { writersDrained: true })).resolves.toEqual({
			outcome: "active",
			processedCollections: 1,
		});
		expect(await statusRows()).toEqual([
			expect.objectContaining({ collection_id: collection.id, capture_state: "active" }),
		]);
	});

	it("still refuses a slug whose lifecycle belongs to another create in progress", async () => {
		await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		await ctx.db
			.insertInto("_emdash_media_usage_index_status")
			.values({
				adapter_id: "content-media",
				scope_type: "collection",
				scope_key: "posts",
				status: "never",
				collection_id: "other-create",
				capture_state: "installing",
				cursor: "another-fingerprint",
				updated_at: new Date().toISOString(),
			})
			.execute();

		await expect(
			new SchemaRegistry(ctx.db).createCollection({ slug: "posts", label: "Posts" }),
		).rejects.toThrow(/identity conflict/i);
		expect(await statusRows()).toEqual([
			expect.objectContaining({ collection_id: "other-create", capture_state: "installing" }),
		]);
	});

	function statusRows() {
		return ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select(["collection_id", "capture_state"])
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", "posts")
			.execute();
	}
});
