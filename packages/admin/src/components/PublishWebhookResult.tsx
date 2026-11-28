/**
 * Beside the Publish button: whether the live site answered the publish
 * webhook the webhook notifier plugin sent, with a retry when it didn't.
 */

import { Button, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ArrowClockwise, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchPublishWebhookStatus,
	type PublishWebhookStatus,
	retryPublishWebhook,
} from "../lib/api/publish-webhook.js";

const POLL_INTERVAL_MS = 1500;
const POLL_LIMIT_MS = 20_000;
const LEADING_WWW = /^www\./;

interface PublishWebhookResultProps {
	collection: string;
	entryId: string;
	isLive: boolean;
	/** Advanced each time the entry is published from this editor. */
	publishToken: number;
	/** The entry on the live site, when it has a public URL. */
	liveUrl: string | null;
}

function hostOf(url: string | null): string | null {
	if (!url) return null;
	try {
		return new URL(url, window.location.href).host.replace(LEADING_WWW, "");
	} catch {
		return null;
	}
}

export function PublishWebhookResult({
	collection,
	entryId,
	isLive,
	publishToken,
	liveUrl,
}: PublishWebhookResultProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const queryKey = React.useMemo(
		() => ["publish-webhook", collection, entryId] as const,
		[collection, entryId],
	);
	const [waiting, setWaiting] = React.useState<{ after: string | null; since: number } | null>(
		null,
	);

	const { data } = useQuery({
		queryKey,
		queryFn: () => fetchPublishWebhookStatus(entryId),
		enabled: isLive || waiting !== null,
		refetchInterval: waiting ? POLL_INTERVAL_MS : false,
	});

	const lastToken = React.useRef(publishToken);
	React.useEffect(() => {
		if (publishToken === lastToken.current) return;
		lastToken.current = publishToken;
		const previous = queryClient.getQueryData<PublishWebhookStatus>(queryKey);
		setWaiting({ after: previous?.delivery?.id ?? null, since: Date.now() });
		void queryClient.invalidateQueries({ queryKey });
	}, [publishToken, queryClient, queryKey]);

	const deliveryId = data?.delivery?.id ?? null;
	React.useEffect(() => {
		if (!waiting) return;
		if (deliveryId !== waiting.after || data?.configured === false) {
			setWaiting(null);
			return;
		}
		const timer = setTimeout(
			setWaiting,
			Math.max(0, POLL_LIMIT_MS - (Date.now() - waiting.since)),
			null,
		);
		return () => clearTimeout(timer);
	}, [data?.configured, deliveryId, waiting]);

	const retry = useMutation({
		mutationFn: () => retryPublishWebhook(collection, entryId),
		onSuccess: (result) => queryClient.setQueryData(queryKey, result),
	});

	if (!isLive || !data?.configured) return null;

	if (waiting || retry.isPending) {
		return (
			<span
				role="status"
				className="col-span-4 flex sm:col-auto items-center gap-1.5 text-sm text-kumo-subtle"
			>
				<Loader size="sm" aria-hidden="true" />
				{t`Updating the live site…`}
			</span>
		);
	}

	const delivery = data.delivery;
	if (!delivery) return null;

	if (delivery.status === "success") {
		const host = hostOf(liveUrl);
		return (
			<span
				role="status"
				className="col-span-4 flex sm:col-auto min-w-0 items-center gap-1.5 text-sm text-kumo-success"
			>
				<CheckCircle className="size-4 shrink-0" aria-hidden="true" weight="fill" />
				{host && liveUrl ? (
					<a
						href={liveUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="truncate underline-offset-2 hover:underline"
					>
						{t`Live on ${host}`}
					</a>
				) : (
					<span className="truncate">{t`Live site updated`}</span>
				)}
			</span>
		);
	}

	const status = delivery.httpStatus;
	return (
		<span
			role="status"
			className="col-span-4 flex sm:col-auto min-w-0 items-center gap-1.5 text-sm text-kumo-danger"
		>
			<WarningCircle className="size-4 shrink-0" aria-hidden="true" weight="fill" />
			<span className="truncate" title={delivery.error ?? undefined}>
				{status ? t`Site didn't answer (${status})` : t`Site didn't answer`}
			</span>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				icon={<ArrowClockwise aria-hidden="true" />}
				onClick={() => retry.mutate()}
			>
				{t`Retry`}
			</Button>
			{retry.error ? <span className="text-xs">{t`Retry failed`}</span> : null}
		</span>
	);
}
