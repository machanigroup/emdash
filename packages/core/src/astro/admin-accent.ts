/** A hex colour: `#rgb` or `#rrggbb`. Anything else could carry CSS of its own into the admin's stylesheet. */
export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The admin stylesheet that recolours Kumo's brand tokens with `admin.accentColor`: primary buttons and the brand fill, their
 * hover, and links, which are darkened in light mode and lightened in dark mode so they keep their contrast. Null when no
 * valid colour is configured.
 */
export function adminAccentCss(color: string | undefined): string | null {
	if (!color || !HEX_COLOR.test(color)) return null;
	return [
		":root {",
		`\t--color-kumo-brand: ${color};`,
		`\t--color-kumo-brand-hover: color-mix(in oklab, ${color} 82%, black);`,
		`\t--text-color-kumo-link: light-dark(color-mix(in oklab, ${color} 85%, black), color-mix(in oklab, ${color} 55%, white));`,
		"}",
	].join("\n");
}
