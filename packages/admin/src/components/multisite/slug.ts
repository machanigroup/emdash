const DIACRITICS = /\p{Diacritic}/gu;
const NON_SLUG_CHARACTERS = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;
const TRAILING_HYPHENS = /-+$/;

/** A slug suggestion for an organization or site name: lowercase words joined by hyphens. */
export function slugFromName(name: string): string {
	return name
		.normalize("NFKD")
		.replace(DIACRITICS, "")
		.toLowerCase()
		.replace(NON_SLUG_CHARACTERS, "-")
		.replace(EDGE_HYPHENS, "")
		.slice(0, 63)
		.replace(TRAILING_HYPHENS, "");
}
