import { type Kysely, sql } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";

import * as m001 from "./migrations/001_organizations.js";
import * as m002 from "./migrations/002_site_handoffs.js";
import type { ControlPlaneDatabase } from "./types.js";

/**
 * Control-plane migrations are tracked in their own tables so a control plane
 * can share a physical database with a site without the two migration sets
 * interfering.
 */
const CONTROL_PLANE_MIGRATION_TABLE = "_emdash_control_migrations";
const CONTROL_PLANE_MIGRATION_LOCK_TABLE = "_emdash_control_migrations_lock";

const MIGRATIONS: Record<string, Migration> = {
	"001_organizations": m001,
	"002_site_handoffs": m002,
};

class ControlPlaneMigrationProvider implements MigrationProvider {
	async getMigrations(): Promise<Record<string, Migration>> {
		return MIGRATIONS;
	}
}

/**
 * Whether every control-plane migration is recorded as applied. Checked before
 * running the migrator, which takes a database-wide lock even when nothing is
 * pending; on a pooled Postgres connection such as Hyperdrive, that lock can
 * outlive the request that took it.
 */
async function allApplied(db: Kysely<ControlPlaneDatabase>): Promise<boolean> {
	try {
		const { rows } = await sql<{ name: string }>`
			select name from ${sql.table(CONTROL_PLANE_MIGRATION_TABLE)}
		`.execute(db);
		const applied = new Set(rows.map((row) => row.name));
		return Object.keys(MIGRATIONS).every((name) => applied.has(name));
	} catch {
		return false;
	}
}

export async function runControlPlaneMigrations(
	db: Kysely<ControlPlaneDatabase>,
): Promise<{ applied: string[] }> {
	if (await allApplied(db)) return { applied: [] };
	const migrator = new Migrator({
		db,
		provider: new ControlPlaneMigrationProvider(),
		migrationTableName: CONTROL_PLANE_MIGRATION_TABLE,
		migrationLockTableName: CONTROL_PLANE_MIGRATION_LOCK_TABLE,
	});
	const { error, results } = await migrator.migrateToLatest();
	if (error) {
		throw new Error("Control-plane migration failed", { cause: error });
	}
	return {
		applied: (results ?? [])
			.filter((result) => result.status === "Success")
			.map((result) => result.migrationName),
	};
}
