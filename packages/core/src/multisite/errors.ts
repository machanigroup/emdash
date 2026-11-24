export type MultiSiteErrorCode =
	| "INVALID_SLUG"
	| "INVALID_HOSTNAME"
	| "INVALID_ROLE"
	| "NOT_FOUND"
	| "NOT_A_MEMBER";

export class MultiSiteError extends Error {
	constructor(
		public readonly code: MultiSiteErrorCode,
		message: string,
	) {
		super(message);
		this.name = "MultiSiteError";
	}
}
