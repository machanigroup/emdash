import {
	Button,
	Checkbox,
	Input,
	InputArea,
	LayerDialog,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import {
	importMediaFromStorage,
	scanMediaStorage,
	type StorageImportResult,
	type StorageScanItem,
} from "../lib/api";
import { formatFileSize } from "../lib/media-utils.js";
import { DialogError, getMutationError } from "./DialogError.js";

const IMPORT_BATCH_SIZE = 100;

function excludePatterns(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export interface MediaStorageImportDialogProps {
	open: boolean;
	onClose: () => void;
	onImported: (result: StorageImportResult) => void;
}

/** Finds files in the site's storage that have no media record and registers the chosen ones. */
export function MediaStorageImportDialog({
	open,
	onClose,
	onImported,
}: MediaStorageImportDialogProps) {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const formId = React.useId();
	const [prefix, setPrefix] = React.useState("");
	const [excludeText, setExcludeText] = React.useState("");
	const [items, setItems] = React.useState<StorageScanItem[] | null>(null);
	const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
	const [nextCursor, setNextCursor] = React.useState<string | undefined>();
	const [scannedCount, setScannedCount] = React.useState(0);
	const [fileByPath, setFileByPath] = React.useState(true);

	React.useEffect(() => {
		if (!open) return;
		setItems(null);
		setSelected(new Set());
		setNextCursor(undefined);
		setScannedCount(0);
	}, [open]);

	const scanMutation = useMutation({
		mutationFn: (cursor: string | undefined) =>
			scanMediaStorage({
				prefix: prefix.trim() || undefined,
				exclude: excludePatterns(excludeText),
				cursor,
				limit: 100,
			}),
		onSuccess: (page, cursor) => {
			const found = cursor ? [...(items ?? []), ...page.items] : page.items;
			setItems(found);
			setSelected((current) => {
				const next = cursor ? new Set(current) : new Set<string>();
				for (const item of page.items) next.add(item.key);
				return next;
			});
			setScannedCount((count) => (cursor ? count : 0) + page.scannedCount);
			setNextCursor(page.nextCursor);
		},
	});

	const importMutation = useMutation({
		mutationFn: async (keys: string[]) => {
			const result: StorageImportResult = { imported: [], skipped: [] };
			for (let start = 0; start < keys.length; start += IMPORT_BATCH_SIZE) {
				// oxlint-disable-next-line no-await-in-loop -- batches run in order so a failure stops the rest
				const batch = await importMediaFromStorage({
					keys: keys.slice(start, start + IMPORT_BATCH_SIZE),
					folder: { mode: fileByPath ? "path" : "none" },
					exclude: excludePatterns(excludeText),
				});
				result.imported.push(...batch.imported);
				result.skipped.push(...batch.skipped);
			}
			return result;
		},
		onSuccess: (result) => {
			const done = new Set([...result.imported, ...result.skipped.map((entry) => entry.key)]);
			setItems((current) => current?.filter((item) => !done.has(item.key)) ?? null);
			setSelected(new Set());
			const count = result.imported.length;
			toastManager.add({
				title: plural(count, {
					one: "Added # file to the library",
					other: "Added # files to the library",
				}),
				variant: "success",
				timeout: 4000,
			});
			onImported(result);
		},
	});

	const isPending = scanMutation.isPending || importMutation.isPending;
	const allSelected = items !== null && items.length > 0 && selected.size === items.length;
	const someSelected = selected.size > 0 && !allSelected;

	const toggle = (key: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	const scan = (event: React.FormEvent) => {
		event.preventDefault();
		if (isPending) return;
		importMutation.reset();
		scanMutation.mutate(undefined);
	};

	return (
		<LayerDialog.Root
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && !isPending) onClose();
			}}
			dismissDisabled={isPending}
		>
			<LayerDialog.Content size="lg">
				<LayerDialog.Title>{t`Import from storage`}</LayerDialog.Title>
				<LayerDialog.Description>
					{t`Find files in this site's storage that are not in the media library yet, and add them.`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					<div className="grid gap-5">
						<form id={formId} onSubmit={scan} noValidate className="grid gap-4">
							<Input
								label={t`Folder or prefix`}
								description={t`Leave empty to scan the whole bucket.`}
								placeholder="products/"
								value={prefix}
								onChange={(event) => setPrefix(event.target.value)}
								disabled={isPending}
								dir="ltr"
							/>
							<InputArea
								label={t`Leave out`}
								description={t`One per line: a folder such as frames/, or a pattern such as *-640.webp.`}
								value={excludeText}
								onChange={(event) => setExcludeText(event.target.value)}
								disabled={isPending}
								minRows={2}
								dir="ltr"
							/>
							<div>
								<Button type="submit" variant="secondary" disabled={isPending}>
									{scanMutation.isPending
										? t`Scanning...`
										: items === null
											? t`Scan storage`
											: t`Scan again`}
								</Button>
							</div>
						</form>

						{items !== null && (
							<div className="grid gap-3 border-t border-kumo-line pt-5">
								<p className="text-sm text-kumo-subtle" role="status">
									{nextCursor
										? plural(scannedCount, {
												one: "Checked # object so far.",
												other: "Checked # objects so far.",
											})
										: plural(scannedCount, {
												one: "Checked # object.",
												other: "Checked # objects.",
											})}{" "}
									{plural(items.length, {
										one: "# file is not in the library.",
										other: "# files are not in the library.",
									})}
								</p>
								{items.length > 0 && (
									<>
										<Checkbox
											checked={allSelected}
											indeterminate={someSelected}
											onCheckedChange={() =>
												setSelected(
													allSelected ? new Set() : new Set(items.map((item) => item.key)),
												)
											}
											label={t`Select all`}
											disabled={isPending}
										/>
										<ul
											className="max-h-72 divide-y divide-kumo-line overflow-y-auto rounded-md border border-kumo-line"
											aria-label={t`Files not in the library`}
										>
											{items.map((item) => (
												<li key={item.key} className="flex items-center gap-3 px-3 py-2">
													<Checkbox
														checked={selected.has(item.key)}
														onCheckedChange={() => toggle(item.key)}
														disabled={isPending}
														label={
															<span className="grid min-w-0 gap-0.5 font-normal">
																<span className="truncate text-sm" dir="ltr">
																	{item.key}
																</span>
																<span className="text-xs text-kumo-subtle">
																	{item.mimeType} · {formatFileSize(item.size)}
																</span>
															</span>
														}
													/>
												</li>
											))}
										</ul>
									</>
								)}
								{nextCursor && (
									<div>
										<Button
											variant="outline"
											size="sm"
											onClick={() => scanMutation.mutate(nextCursor)}
											disabled={isPending}
										>
											{t`Scan more`}
										</Button>
									</div>
								)}
								{items.length > 0 && (
									<Checkbox
										checked={fileByPath}
										onCheckedChange={() => setFileByPath((value) => !value)}
										label={t`Put each file in a folder named after its path`}
										disabled={isPending}
									/>
								)}
							</div>
						)}
						<DialogError message={getMutationError(scanMutation.error ?? importMutation.error)} />
					</div>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Close`}>
					<LayerDialog.Action
						onClick={() => importMutation.mutate([...selected])}
						disabled={isPending || selected.size === 0}
					>
						{importMutation.isPending
							? t`Adding...`
							: plural(selected.size, { one: "Add # file", other: "Add # files" })}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}
