/** Invitations sent from the admin's own email: who was invited, and the compose links that write the message. */

export interface InviteResult {
	email: string;
	status: "added" | "invited" | "failed";
	inviteUrl?: string;
	error?: string;
}

const SEPARATORS = /[\s,;]+/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Addresses typed or pasted one per line or comma-separated: the valid ones (lower-cased, without repeats) and the rest. */
export function parseEmailList(text: string): { valid: string[]; invalid: string[] } {
	const valid = new Set<string>();
	const invalid: string[] = [];
	for (const entry of text.split(SEPARATORS)) {
		const email = entry.trim().replace(/^<|>$/g, "").toLowerCase();
		if (!email) continue;
		if (EMAIL.test(email)) valid.add(email);
		else invalid.push(entry.trim());
	}
	return { valid: [...valid], invalid };
}

/** Gmail's compose window, filled in. Several people go in Bcc, so nobody sees the others' addresses. */
export function gmailComposeUrl(recipients: string[], subject: string, body: string): string {
	const params = new URLSearchParams({ view: "cm", fs: "1" });
	params.set(recipients.length === 1 ? "to" : "bcc", recipients.join(","));
	params.set("su", subject);
	params.set("body", body);
	return `https://mail.google.com/mail/?${params.toString()}`;
}

/** The same message for the default email app. */
export function mailtoUrl(recipients: string[], subject: string, body: string): string {
	const to = recipients.length === 1 ? encodeURIComponent(recipients[0]!) : "";
	const bcc = recipients.length > 1 ? `bcc=${encodeURIComponent(recipients.join(","))}&` : "";
	return `mailto:${to}?${bcc}subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
