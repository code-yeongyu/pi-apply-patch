import { describe, expect, it } from "vitest";
import {
	displayPath,
	formatInFlightCallText,
	formatPatchPreview,
	PATCH_PREVIEW_MAX_CHARS,
	PATCH_PREVIEW_MAX_LINES,
	truncatePreview,
} from "../src/index.js";

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

	it("#given absolute path under cwd #when displaying #then returns relative path", () => {
		// given
		const cwd = "/workspace/project";
		const absolute = "/workspace/project/src/index.ts";

		// when
		const rendered = displayPath(absolute, cwd);

		// then
		expect(rendered).toBe("src/index.ts");
	});

	it("#given absolute path outside cwd #when displaying #then keeps absolute path", () => {
		// given
		const cwd = "/workspace/project";
		const absolute = "/tmp/file.ts";

		// when
		const rendered = displayPath(absolute, cwd);

		// then
		expect(rendered).toBe(absolute);
	});

	it("#given expanded false #when formatting preview #then renders headers only", () => {
		// given
		const preview = {
			files: [
				{
					filePath: "/workspace/project/src/foo.ts",
					operation: "update" as const,
					diff: "-1 old\n+1 new",
					added: 1,
					removed: 1,
				},
			],
			added: 1,
			removed: 1,
		};

		// when
		const collapsed = formatPatchPreview(preview, "/workspace/project", false);
		const expanded = formatPatchPreview(preview, "/workspace/project", true);

		// then
		expect(collapsed).toContain("• Edited src/foo.ts (+1 -1)");
		expect(collapsed).not.toContain("+1 new");
		expect(expanded).toContain("+1 new");
	});

	it("#given omitted optional args #when formatting preview #then keeps backward compatible defaults", () => {
		// given
		const preview = {
			files: [
				{
					filePath: "src/foo.ts",
					operation: "update" as const,
					diff: "-1 old\n+1 new",
					added: 1,
					removed: 1,
				},
			],
			added: 1,
			removed: 1,
		};

		// when
		const rendered = formatPatchPreview(preview);

		// then
		expect(rendered).toContain("• Edited src/foo.ts (+1 -1)");
		expect(rendered).toContain("+1 new");
	});

	it("#given parseable call text #when formatting in-flight label #then includes count and paths", () => {
		// given
		const patch = `*** Begin Patch
*** Update File: src/a.ts
*** Add File: src/b.ts
*** End Patch`;

		// when
		const callText = formatInFlightCallText(patch);

		// then
		expect(callText).toContain("(2 files)");
		expect(callText).toContain("src/a.ts");
		expect(callText).toContain("src/b.ts");
	});
});
