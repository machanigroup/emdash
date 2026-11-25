import { z } from "zod";

const slug = z
	.string()
	.trim()
	.regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "Use lowercase letters, numbers, and hyphens");
const name = z.string().trim().min(1).max(200);
const role = z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(40), z.literal(50)]);
const hostname = z.string().trim().min(1).max(253);

export const orgCreateBody = z.object({ slug, name });

export const orgUpdateBody = z.object({ name });

export const siteCreateBody = z.object({
	slug,
	name,
	databaseRef: z.string().min(1),
	storageRef: z.string().min(1).nullable().optional(),
	hostnames: z.array(hostname).max(20).default([]),
});

export const siteUpdateBody = z
	.object({
		name: name.optional(),
		status: z.enum(["active", "disabled"]).optional(),
		hostnames: z.array(hostname).max(20).optional(),
	})
	.refine((body) => Object.keys(body).length > 0, "Nothing to update");

export const orgMemberAddBody = z.object({ email: z.email(), role });

export const orgMemberUpdateBody = z.object({ role });

export const siteRoleBody = z.object({ role });
