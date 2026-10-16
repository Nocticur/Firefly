import type { SponsorMethod } from "../types/sponsorConfig";

/** Ignore incomplete payment entries before rendering, including unsafe URLs. */
export function getEnabledSponsorMethods(
	methods: SponsorMethod[],
): SponsorMethod[] {
	return methods.filter((method) => {
		if (!method.enabled || !method.name.trim()) return false;
		const value = (method.type === "qrcode" ? method.image : method.url).trim();
		if (
			!value ||
			Array.from(value).some(
				(character) => character.charCodeAt(0) <= 32 || character === "\\",
			)
		)
			return false;
		if (method.type === "qrcode") {
			if (/^\/(?!\/)/.test(value)) return true;
			if (
				/^data:image\/(png|jpeg|webp|avif);base64,[a-z0-9+/]+={0,2}$/i.test(
					value,
				)
			)
				return true;
			if (/^assets\/.+\.(png|jpe?g|webp|avif)$/i.test(value)) {
				return value
					.split("/")
					.every(
						(segment) =>
							segment !== ".." &&
							segment !== "." &&
							segment !== "" &&
							!segment.includes("%"),
					);
			}
		}
		try {
			const target = new URL(value);
			return (
				target.protocol === "https:" && !target.username && !target.password
			);
		} catch {
			return false;
		}
	});
}
