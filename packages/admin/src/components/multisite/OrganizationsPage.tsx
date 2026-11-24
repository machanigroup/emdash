/**
 * Organizations of a multi-site deployment that the user belongs to, or every
 * organization for a deployment Admin.
 */

import {
	Badge,
	Banner,
	Button,
	Input,
	LayerDialog,
	Loader,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { createOrganization, fetchOrganizations } from "../../lib/api";
import { DialogError, getMutationError } from "../DialogError.js";
import { SettingRow, SettingsFrame, SettingsSection } from "../settings/SettingsLayout.js";
import { useRolesConfig } from "../users/useRolesConfig.js";
import { slugFromName } from "./slug.js";

export function OrganizationsPage() {
	const { t } = useLingui();
	const { getRoleLabel } = useRolesConfig();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const toastManager = useKumoToastManager();
	const [creating, setCreating] = React.useState(false);
	const [name, setName] = React.useState("");
	const [slug, setSlug] = React.useState("");
	const [slugEdited, setSlugEdited] = React.useState(false);
	const formId = React.useId();

	const { data, isLoading, error } = useQuery({
		queryKey: ["multisite", "orgs"],
		queryFn: fetchOrganizations,
	});

	const createMutation = useMutation({
		mutationFn: (input: { name: string; slug: string }) => createOrganization(input),
		onSuccess: ({ id }) => {
			void queryClient.invalidateQueries({ queryKey: ["multisite"] });
			setCreating(false);
			toastManager.add({ title: t`Organization created`, variant: "success", timeout: 3000 });
			void navigate({ to: "/organizations/$orgId", params: { orgId: id } });
		},
	});

	const title = t`Organizations`;
	const description = t`Organizations group sites and the people who work on them. A member's role in an organization applies to all of its sites.`;

	if (isLoading) {
		return (
			<SettingsFrame title={title} description={description}>
				<div role="status" className="flex items-center gap-2 text-sm text-kumo-subtle">
					<Loader size="sm" />
					<span>{t`Loading...`}</span>
				</div>
			</SettingsFrame>
		);
	}

	if (error || !data) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="error"
					title={t`Failed to load organizations`}
					description={error instanceof Error ? error.message : undefined}
					role="alert"
				/>
			</SettingsFrame>
		);
	}

	const openCreate = () => {
		createMutation.reset();
		setName("");
		setSlug("");
		setSlugEdited(false);
		setCreating(true);
	};

	const handleCreate = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!name.trim() || !slug || createMutation.isPending) return;
		createMutation.mutate({ name: name.trim(), slug });
	};

	return (
		<SettingsFrame
			title={title}
			description={description}
			actions={
				data.canCreate ? (
					<Button icon={<Plus />} onClick={openCreate}>
						{t`New organization`}
					</Button>
				) : undefined
			}
		>
			<SettingsSection title={t`Your organizations`}>
				{data.items.length > 0 ? (
					data.items.map((org) => (
						<SettingRow key={org.id}>
							<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
								<div className="min-w-0">
									<Link
										to="/organizations/$orgId"
										params={{ orgId: org.id }}
										className="text-sm font-medium hover:underline"
									>
										{org.name}
									</Link>
									<div className="flex gap-3 text-sm text-kumo-subtle">
										<span>{plural(org.siteCount, { one: "# site", other: "# sites" })}</span>
										<span>{plural(org.memberCount, { one: "# member", other: "# members" })}</span>
									</div>
								</div>
								{org.role !== null && <Badge variant="neutral">{getRoleLabel(org.role)}</Badge>}
							</div>
						</SettingRow>
					))
				) : (
					<SettingRow className="py-8 text-center text-sm text-kumo-subtle">
						{data.canCreate
							? t`No organizations yet. Create one to add sites and members.`
							: t`You aren't a member of any organization yet. Ask an organization Admin to add you.`}
					</SettingRow>
				)}
			</SettingsSection>

			<LayerDialog.Root
				open={creating}
				onOpenChange={(open) => !createMutation.isPending && setCreating(open)}
			>
				<LayerDialog.Content>
					<LayerDialog.Title>{t`New organization`}</LayerDialog.Title>
					<LayerDialog.Description>
						{t`You become the organization's Admin. Deployment Admins can then add its sites.`}
					</LayerDialog.Description>
					<LayerDialog.Body>
						<form id={formId} noValidate onSubmit={handleCreate} className="grid gap-4">
							<Input
								label={t`Name`}
								value={name}
								required
								onChange={(event) => {
									setName(event.target.value);
									if (!slugEdited) setSlug(slugFromName(event.target.value));
								}}
							/>
							<Input
								dir="ltr"
								label={t`Slug`}
								description={t`Lowercase letters, numbers, and hyphens.`}
								value={slug}
								required
								onChange={(event) => {
									setSlugEdited(true);
									setSlug(event.target.value);
								}}
							/>
							<DialogError message={getMutationError(createMutation.error)} />
						</form>
					</LayerDialog.Body>
					<LayerDialog.Actions dismissLabel={t`Cancel`}>
						<LayerDialog.Action
							type="submit"
							form={formId}
							disabled={!name.trim() || !slug || createMutation.isPending}
						>
							{createMutation.isPending ? t`Creating...` : t`Create organization`}
						</LayerDialog.Action>
					</LayerDialog.Actions>
				</LayerDialog.Content>
			</LayerDialog.Root>
		</SettingsFrame>
	);
}

export default OrganizationsPage;
