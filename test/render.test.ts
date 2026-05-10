import { describe, expect, it } from "vitest";
import { PATCH_PREVIEW_MAX_CHARS, PATCH_PREVIEW_MAX_LINES, truncatePreview } from "../src/index.js";

describe("render helpers", () => {
	it("#given long diff #when truncating #then keeps head and tail", () => {
		// given
		const lines = Array.from({ length: PATCH_PREVIEW_MAX_LINES + 12 }, (_, index) => `line-${index + 1}`);
		const diff = lines.join("\n");

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview).toContain("line-1");
		expect(preview).toContain(`line-${lines.length}`);
		expect(preview).toContain("…");
	});

	it("#given huge payload #when truncating #then enforces max chars", () => {
		// given
		const diff = `${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}\nend`;

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS + 2);
		expect(preview).toContain("…");
	});
});
