import { Button, LinkButton, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowClockwise,
	ArrowSquareOut,
	Browser,
	DesktopTower,
	DeviceMobile,
	X,
} from "@phosphor-icons/react";
import * as React from "react";

import { cn } from "../lib/utils.js";

const PREVIEW_PANE_STORAGE_KEY = "emdash-editor-preview-pane";
/** Reloads wait this long after the last save, so a run of autosaves reloads the page once. */
const RELOAD_DELAY_MS = 600;
const MOBILE_WIDTH_PX = 390;

type Width = "desktop" | "mobile";

function readPreviewPaneOpen(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(PREVIEW_PANE_STORAGE_KEY) === "open";
	} catch {
		return false;
	}
}

function writePreviewPaneOpen(open: boolean): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(PREVIEW_PANE_STORAGE_KEY, open ? "open" : "closed");
	} catch {}
}

/** Whether the editor shows the preview beside it. Remembered across entries and visits. */
export function usePreviewPane(): { open: boolean; toggle: () => void; close: () => void } {
	const [open, setOpen] = React.useState(readPreviewPaneOpen);
	const toggle = React.useCallback(() => {
		setOpen((current) => {
			writePreviewPaneOpen(!current);
			return !current;
		});
	}, []);
	const close = React.useCallback(() => {
		writePreviewPaneOpen(false);
		setOpen(false);
	}, []);
	return { open, toggle, close };
}

export interface PreviewPaneToggleProps {
	open: boolean;
	onClick: () => void;
	controls: string;
	disabled?: boolean;
}

/** Shows or hides the preview beside the editor. Its label names what a click does. */
export function PreviewPaneToggle({ open, onClick, controls, disabled }: PreviewPaneToggleProps) {
	const { t } = useLingui();
	const label = open ? t`Hide the site beside the editor` : t`Show the site beside the editor`;
	return (
		<Button
			variant="ghost"
			shape="square"
			size="sm"
			type="button"
			disabled={disabled}
			onClick={onClick}
			aria-controls={controls}
			aria-expanded={open}
			aria-label={label}
			title={label}
			icon={<Browser />}
		/>
	);
}

export interface EditorPreviewPaneProps {
	id: string;
	/** Resolves a fresh, signed preview URL for the entry's saved draft. */
	resolveUrl: () => Promise<string>;
	/** Changes whenever a save lands, which reloads the preview. */
	version: string | number | null;
	onClose: () => void;
	className?: string;
}

/** The entry's preview, beside the editor, reloaded after each save. */
export function EditorPreviewPane({
	id,
	resolveUrl,
	version,
	onClose,
	className,
}: EditorPreviewPaneProps) {
	const { t } = useLingui();
	const [url, setUrl] = React.useState<string | null>(null);
	const [failed, setFailed] = React.useState(false);
	const [loading, setLoading] = React.useState(true);
	const [width, setWidth] = React.useState<Width>("desktop");
	const [reloads, setReloads] = React.useState(0);
	const resolveRef = React.useRef(resolveUrl);
	resolveRef.current = resolveUrl;
	const firstLoadRef = React.useRef(true);

	React.useEffect(() => {
		let cancelled = false;
		const load = async () => {
			setLoading(true);
			try {
				const next = await resolveRef.current();
				if (cancelled) return;
				setFailed(false);
				setUrl(next);
			} catch {
				if (cancelled) return;
				setFailed(true);
				setLoading(false);
			}
		};
		if (firstLoadRef.current) {
			firstLoadRef.current = false;
			void load();
			return () => {
				cancelled = true;
			};
		}
		const timer = setTimeout(load, RELOAD_DELAY_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [version, reloads]);

	const shown = url ? displayAddress(url) : null;

	return (
		<section
			id={id}
			aria-label={t`Preview`}
			className={cn("flex min-h-0 flex-col border-s border-kumo-line bg-kumo-base", className)}
		>
			<div className="flex h-11 shrink-0 items-center gap-1 border-b border-kumo-line px-2">
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					type="button"
					aria-pressed={width === "desktop"}
					className={width === "desktop" ? "bg-kumo-tint" : undefined}
					aria-label={t`Desktop width`}
					title={t`Desktop width`}
					onClick={() => setWidth("desktop")}
					icon={<DesktopTower />}
				/>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					type="button"
					aria-pressed={width === "mobile"}
					className={width === "mobile" ? "bg-kumo-tint" : undefined}
					aria-label={t`Phone width`}
					title={t`Phone width`}
					onClick={() => setWidth("mobile")}
					icon={<DeviceMobile />}
				/>
				<span
					className="min-w-0 flex-1 truncate px-2 text-center text-xs text-kumo-subtle"
					dir="ltr"
					title={shown ?? undefined}
				>
					{shown}
				</span>
				{loading && url ? <Loader size="sm" aria-label={t`Reloading preview`} /> : null}
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					type="button"
					aria-label={t`Reload preview`}
					title={t`Reload preview`}
					onClick={() => setReloads((count) => count + 1)}
					icon={<ArrowClockwise />}
				/>
				{url ? (
					<LinkButton
						href={url}
						external
						variant="ghost"
						shape="square"
						size="sm"
						aria-label={t`Open preview in a new tab`}
						title={t`Open preview in a new tab`}
						icon={<ArrowSquareOut className="rtl:-scale-x-100" />}
					/>
				) : null}
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					type="button"
					aria-label={t`Close preview`}
					title={t`Close preview`}
					onClick={onClose}
					icon={<X />}
				/>
			</div>
			<div className="relative flex min-h-0 flex-1 justify-center overflow-auto bg-kumo-tint">
				{failed ? (
					<p role="alert" className="m-auto max-w-xs p-6 text-center text-sm text-kumo-subtle">
						{t`The preview couldn’t be loaded. Save your changes, then reload the preview.`}
					</p>
				) : url ? (
					<iframe
						key={url}
						src={url}
						title={t`Preview of this entry`}
						onLoad={() => setLoading(false)}
						className={cn(
							"h-full border-0 bg-white",
							width === "mobile" ? "shrink-0 border-x border-kumo-line" : "w-full",
						)}
						style={width === "mobile" ? { width: MOBILE_WIDTH_PX } : undefined}
					/>
				) : (
					<div className="m-auto">
						<Loader aria-label={t`Loading preview`} />
					</div>
				)}
			</div>
		</section>
	);
}

/** The address bar text: host and path, without the preview token. */
function displayAddress(url: string): string {
	try {
		const parsed = new URL(url, window.location.href);
		parsed.searchParams.delete("_preview");
		const query = parsed.searchParams.toString();
		return `${parsed.host}${parsed.pathname}${query ? `?${query}` : ""}`;
	} catch {
		return url;
	}
}
