/**
 * Fail-fast Postgres migration locking.
 *
 * Kysely's stock `PostgresAdapter.acquireMigrationLock` runs
 * `select pg_advisory_xact_lock(...)` — an unbounded blocking wait on a
 * database-wide advisory lock, held for the whole migration transaction.
 * On Cloudflare Workers that is a stampede amplifier (#1744): every isolate
 * that cold-starts while migrations are pending parks a connection inside
 * Postgres waiting for the lock, and when the holder's migration fails and
 * rolls back, the next waiter acquires the lock and re-runs the same
 * failing migration.
 *
 * `FailFastPostgresDialect` swaps the blocking wait for a lock that is tried
 * once: `pg_try_advisory_xact_lock` inside the migration transaction, or a
 * claim on the migration lock table's row when Kysely takes the lock before
 * the transaction starts (0.29.9 and later). When another migrator holds the
 * lock, the adapter throws `MIGRATION_LOCK_BUSY_MESSAGE` immediately instead
 * of queueing inside the database. `runMigrations` treats that error like the
 * SQLite concurrent-migration race — it polls the migration table with
 * cheap bounded SELECTs until the concurrent migrator finishes (or the
 * wait deadline passes), without holding a transaction open.
 */

import type { DialectAdapter, Kysely, MigrationLockOptions } from "kysely";
import { PostgresAdapter as KyselyPostgresAdapter, PostgresDialect, sql } from "kysely";

/**
 * Sentinel message thrown when another migrator holds the migration lock.
 * `runMigrations` matches on it to route into the concurrent-migrator wait.
 */
export const MIGRATION_LOCK_BUSY_MESSAGE = "EMDASH_MIGRATION_LOCK_BUSY";

/**
 * Kysely's advisory lock id (LOCK_ID in kysely's postgres-adapter). Reused
 * deliberately: during a rolling deploy, old isolates still run the stock
 * blocking adapter, and using the same id keeps old and new builds mutually
 * exclusive on the same lock.
 */
const KYSELY_PG_MIGRATION_LOCK_ID = BigInt("3853314791062309107");

/**
 * A lock row older than this belongs to a migrator that stopped without
 * releasing it. Postgres runs each migration batch in a transaction, so a
 * stopped holder left nothing half-applied, and its lock can be taken over.
 */
const STALE_LOCK_SECONDS = 10 * 60;

/**
 * Extends the stock adapter so every capability flag and `instanceof` check
 * is inherited.
 *
 * Kysely before 0.29.9 takes the lock inside the migration transaction, where
 * a transaction-level advisory lock holds until commit. From 0.29.9 it takes
 * the lock on the connection before the transaction starts: a
 * transaction-level lock taken there ends with its own statement, and a
 * session-level lock cannot be trusted either, because a pooler such as
 * Hyperdrive may run the release on a different server connection and leave
 * the lock held. Outside a transaction, the lock is therefore a claim on the
 * row of Kysely's migration lock table, which every connection sees.
 */
class PostgresAdapter extends KyselyPostgresAdapter {
	// eslint-disable-next-line typescript/no-explicit-any -- matches the DialectAdapter signature
	readonly #held = new WeakMap<Kysely<any>, number>();

	// eslint-disable-next-line typescript/no-explicit-any -- matches the DialectAdapter signature
	override async acquireMigrationLock(
		db: Kysely<any>,
		options: MigrationLockOptions,
	): Promise<void> {
		if (db.isTransaction) {
			const result = await sql<{ acquired: boolean }>`
				select pg_try_advisory_xact_lock(${sql.lit(KYSELY_PG_MIGRATION_LOCK_ID)}) as acquired
			`.execute(db);
			if (!result.rows[0]?.acquired) {
				throw new Error(MIGRATION_LOCK_BUSY_MESSAGE);
			}
			return;
		}
		// Seconds, not milliseconds: Kysely creates `is_locked` as a 32-bit integer.
		const heldSince = Math.floor(Date.now() / 1000);
		const table = options.lockTableSchema
			? db.withSchema(options.lockTableSchema).updateTable(options.lockTable)
			: db.updateTable(options.lockTable);
		const result = await table
			.set({ is_locked: heldSince })
			.where("id", "=", options.lockRowId)
			.where((eb) =>
				eb.or([eb("is_locked", "=", 0), eb("is_locked", "<", heldSince - STALE_LOCK_SECONDS)]),
			)
			.executeTakeFirst();
		if (result.numUpdatedRows !== 1n) {
			throw new Error(MIGRATION_LOCK_BUSY_MESSAGE);
		}
		this.#held.set(db, heldSince);
	}

	// eslint-disable-next-line typescript/no-explicit-any -- matches the DialectAdapter signature
	override async releaseMigrationLock(
		db: Kysely<any>,
		options: MigrationLockOptions,
	): Promise<void> {
		// Kysely also calls this after acquireMigrationLock threw, and inside a
		// transaction the advisory lock ends with the transaction.
		const heldSince = this.#held.get(db);
		if (heldSince === undefined) return;
		this.#held.delete(db);
		const table = options.lockTableSchema
			? db.withSchema(options.lockTableSchema).updateTable(options.lockTable)
			: db.updateTable(options.lockTable);
		await table
			.set({ is_locked: 0 })
			.where("id", "=", options.lockRowId)
			.where("is_locked", "=", heldSince)
			.execute();
	}
}

/**
 * Drop-in replacement for Kysely's `PostgresDialect` whose migration lock
 * fails fast instead of blocking inside the database. Everything except
 * `createAdapter` is inherited unchanged, and because it subclasses
 * `PostgresDialect`, the public dialect type of `emdash/db/postgres` stays
 * `PostgresDialect` and `instanceof` checks keep working.
 */
export class FailFastPostgresDialect extends PostgresDialect {
	override createAdapter(): DialectAdapter {
		return new PostgresAdapter();
	}
}
