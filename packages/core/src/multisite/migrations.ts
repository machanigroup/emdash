import type { Kysely } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";

import * as m001 from "./migrations/001_organizations.js";
import type { ControlPlaneDatabase } from "./types.js";

/**
 * Control-plane migrations are tracked in their own tables so a control plane
 * can share a physical database with a site without the two migration sets
 * interfering.
 */
const CONTROL_PLANE_MIGRATION_TABLE = "_emdash_control_migrations";
const CONTROL_PLANE_MIGRATION_LOCK_TABLE = "_emdash_control_migrations_lock";

class ControlPlaneMigrationProvider implements MigrationProvider {
	async getMigrations(): Promise<Record<string, Migration>> {
		return {
			"001_organizations": m001,
		};
	}
}

export async function runControlPlaneMigrations(
	db: Kysely<ControlPlaneDatabase>,
): Promise<{ applied: string[] }> {
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
