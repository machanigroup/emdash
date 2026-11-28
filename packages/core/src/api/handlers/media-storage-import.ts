import * as path from "node:path";

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import type { Database } from "../../database/types.js";
import { EXTENSION_TO_MIME, matchesMimeAllowlist } from "../../media/mime.js";
import { readDimensions } from "../../media/placeholder.js";
import type { Storage } from "../../storage/types.js";
import {
	normalizeStorageKeyForGuard,
	PRIVATE_STORAGE_PREFIXES,
} from "../../transfer/staging/keys.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import type { ApiResult } from "../types.js";
import { GLOBAL_UPLOAD_ALLOWLIST } from "./media-allowlist.js";

/** Storage prefixes that hold EmDash's own objects rather than media. */
const NON_MEDIA_PREFIXES: readonly string[] = [
	...PRIVATE_STORAGE_PREFIXES,
	"marketplace/",
	"registry/",
];

/** Enough of an image's head for its dimensions to be read from the header. */
const IMAGE_HEADER_BYTES = 128 * 1024;

export const STORAGE_SCAN_DEFAULT_LIMIT = 50;
export const STORAGE_SCAN_MAX_LIMIT = 100;

export interface StorageScanItem {
	key: string;
	filename: string;
	mimeType: string;
	size: number;
	/** The key's directory, the folder the file is filed under when imported by path. */
	directory: string | null;
}

export interface StorageScanResult {
	items: StorageScanItem[];
	/** Objects this page listed, before unregistered media were picked out. */
	scannedCount: number;
	nextCursor?: string;
}

export type StorageImportFolder =
	| { mode: "path" }
	| { mode: "none" }
	| { mode: "folder"; folderId: string };

export interface StorageImportResult {
	imported: string[];
	skipped: Array<{ key: string; reason: "registered" | "excluded" | "unsupported" | "missing" }>;
}

/**
 * Whether `key` matches an exclusion pattern. A pattern with `*` is matched
 * against the whole key, with `*` standing for any run of characters,
 * slashes included; any other pattern is a key prefix.
 */
export function matchesStoragePattern(key: string, pattern: string): boolean {
	if (!pattern.includes("*")) return key.startsWith(pattern);
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "s").test(key);
}

function isExcluded(key: string, exclude: readonly string[]): boolean {
	return exclude.some((pattern) => matchesStoragePattern(key, pattern));
}

/** The media type of an importable key, or null for a key the library must not register. */
function importableMimeType(key: string): string | null {
	const normalized = normalizeStorageKeyForGuard(key);
	if (normalized === null) return null;
	if (NON_MEDIA_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return null;
	const mimeType = EXTENSION_TO_MIME[path.posix.extname(normalized)];
	if (!mimeType || !matchesMimeAllowlist(mimeType, GLOBAL_UPLOAD_ALLOWLIST)) return null;
	return mimeType;
}

function keyDirectory(key: string): string | null {
	const index = key.lastIndexOf("/");
	return index > 0 ? key.slice(0, index) : null;
}

/** A plain relative prefix with an optional trailing slash, or null when it is not one. */
export function normalizeStoragePrefix(prefix: string): string | null {
	if (prefix === "") return "";
	const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
	return normalizeStorageKeyForGuard(trimmed) === null ? null : prefix;
}

async function findRegisteredKeys(db: Kysely<Database>, keys: string[]): Promise<Set<string>> {
	const registered = new Set<string>();
	for (const batch of chunks(keys, SQL_BATCH_SIZE)) {
		const [media, attempts] = await Promise.all([
			db.selectFrom("media").select("storage_key").where("storage_key", "in", batch).execute(),
			db
				.selectFrom("_emdash_media_upload_attempts")
				.select("storage_key")
				.where("storage_key", "in", batch)
				.execute(),
		]);
		for (const row of media) registered.add(row.storage_key);
		for (const row of attempts) registered.add(row.storage_key);
	}
	return registered;
}

/**
 * One page of the site's storage, reduced to the media objects that have no
 * `media` row yet.
 */
export async function handleMediaStorageScan(
	db: Kysely<Database>,
	storage: Storage,
	options: { prefix?: string; cursor?: string; limit?: number; exclude?: readonly string[] } = {},
): Promise<ApiResult<StorageScanResult>> {
	const prefix = normalizeStoragePrefix(options.prefix ?? "");
	if (prefix === null) {
		return {
			success: false,
			error: { code: "VALIDATION_ERROR", message: "Invalid storage prefix" },
		};
	}
	const limit = Math.max(
		1,
		Math.min(options.limit ?? STORAGE_SCAN_DEFAULT_LIMIT, STORAGE_SCAN_MAX_LIMIT),
	);
	const exclude = options.exclude ?? [];
	try {
		const page = await storage.list({ prefix: prefix || undefined, cursor: options.cursor, limit });
		const candidates: StorageScanItem[] = [];
		for (const file of page.files) {
			const mimeType = importableMimeType(file.key);
			if (!mimeType || isExcluded(file.key, exclude)) continue;
			candidates.push({
				key: file.key,
				filename: path.posix.basename(file.key),
				mimeType,
				size: file.size,
				directory: keyDirectory(file.key),
			});
		}
		const registered = await findRegisteredKeys(
			db,
			candidates.map((item) => item.key),
		);
		return {
			success: true,
			data: {
				items: candidates.filter((item) => !registered.has(item.key)),
				scannedCount: page.files.length,
				nextCursor: page.nextCursor,
			},
		};
	} catch (error) {
		console.error("[media-storage-import] Storage scan failed:", error);
		return {
			success: false,
			error: { code: "STORAGE_SCAN_ERROR", message: "Failed to scan storage" },
		};
	}
}

async function readHead(
	storage: Storage,
	key: string,
	mimeType: string,
): Promise<{ size: number; width?: number; height?: number } | null> {
	let download;
	try {
		download = await storage.download(key, { range: { offset: 0, length: IMAGE_HEADER_BYTES } });
	} catch {
		return null;
	}
	if (!mimeType.startsWith("image/")) {
		await download.body.cancel();
		return { size: download.size };
	}
	const reader = download.body.getReader();
	const parts: Uint8Array[] = [];
	let length = 0;
	while (length < IMAGE_HEADER_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
		length += value.byteLength;
	}
	await reader.cancel();
	const head = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		head.set(part, offset);
		offset += part.byteLength;
	}
	const dimensions = readDimensions(head);
	return { size: download.size, width: dimensions?.width, height: dimensions?.height };
}

async function folderForDirectory(
	db: Kysely<Database>,
	directory: string,
	cache: Map<string, string>,
): Promise<string> {
	const name = directory.slice(0, 200);
	const nameKey = name.normalize("NFKC").toLowerCase();
	const cached = cache.get(nameKey);
	if (cached) return cached;
	const find = () =>
		db.selectFrom("media_folders").select("id").where("name_key", "=", nameKey).executeTakeFirst();
	let folder = await find();
	if (!folder) {
		try {
			await db
				.insertInto("media_folders")
				.values({ id: ulid(), name, name_key: nameKey })
				.execute();
		} catch (error) {
			if (!(await find())) throw error;
		}
		folder = await find();
		if (!folder) throw new Error(`Media folder for ${directory} was not created`);
	}
	cache.set(nameKey, folder.id);
	return folder.id;
}

/**
 * Registers objects already in storage as media. Keys that are registered,
 * excluded, not media, or gone are skipped, so a repeated import is a no-op.
 */
export async function handleMediaStorageImport(
	db: Kysely<Database>,
	storage: Storage,
	input: {
		keys: readonly string[];
		folder: StorageImportFolder;
		exclude?: readonly string[];
		authorId?: string;
	},
): Promise<ApiResult<StorageImportResult>> {
	try {
		if (input.folder.mode === "folder") {
			const folder = await db
				.selectFrom("media_folders")
				.select("id")
				.where("id", "=", input.folder.folderId)
				.executeTakeFirst();
			if (!folder) {
				return { success: false, error: { code: "NOT_FOUND", message: "Media folder not found" } };
			}
		}
		const keys = [...new Set(input.keys)];
		const registered = await findRegisteredKeys(db, keys);
		const folderCache = new Map<string, string>();
		const result: StorageImportResult = { imported: [], skipped: [] };

		for (const key of keys) {
			if (registered.has(key)) {
				result.skipped.push({ key, reason: "registered" });
				continue;
			}
			const mimeType = importableMimeType(key);
			if (!mimeType) {
				result.skipped.push({ key, reason: "unsupported" });
				continue;
			}
			if (isExcluded(key, input.exclude ?? [])) {
				result.skipped.push({ key, reason: "excluded" });
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- one object at a time keeps memory bounded
			const head = await readHead(storage, key, mimeType);
			if (!head) {
				result.skipped.push({ key, reason: "missing" });
				continue;
			}
			const directory = keyDirectory(key);
			const folderId =
				input.folder.mode === "folder"
					? input.folder.folderId
					: input.folder.mode === "path" && directory
						? // oxlint-disable-next-line no-await-in-loop -- folders are cached per directory
							await folderForDirectory(db, directory, folderCache)
						: null;
			// oxlint-disable-next-line no-await-in-loop -- one object at a time keeps memory bounded
			await db
				.insertInto("media")
				.values({
					id: ulid(),
					filename: path.posix.basename(key),
					mime_type: mimeType,
					size: head.size,
					width: head.width ?? null,
					height: head.height ?? null,
					focal_x: null,
					focal_y: null,
					alt: null,
					caption: null,
					storage_key: key,
					status: "ready",
					content_hash: null,
					blurhash: null,
					dominant_color: null,
					created_at: new Date().toISOString(),
					author_id: input.authorId ?? null,
					folder_id: folderId,
				})
				.execute();
			result.imported.push(key);
		}
		return { success: true, data: result };
	} catch (error) {
		console.error("[media-storage-import] Storage import failed:", error);
		return {
			success: false,
			error: { code: "STORAGE_IMPORT_ERROR", message: "Failed to import media from storage" },
		};
	}
}
