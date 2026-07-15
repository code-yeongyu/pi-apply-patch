import { describe, expect, it } from "vitest";
import {
	clearApplyPatchRenderState,
	createApplyPatchTool,
	displayPath,
	formatInFlightCallText,
	formatPatchPreview,
	PATCH_PREVIEW_MAX_CHARS,
	PATCH_PREVIEW_MAX_LINES,
	truncatePreview,
} from "../src/index.js";

const identityTheme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

const markerTheme = {
	fg: (name: string, text: string) => `<fg:${name}>${text}</fg:${name}>`,
	bg: (name: string, text: string) => `<bg:${name}>${text}</bg:${name}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	inverse: (text: string) => `<inverse>${text}</inverse>`,
};

const successBg = "\x1b[48;2;40;50;40m";
const bgReset = "\x1b[49m";
const ansiTheme = {
	fg: (_name: string, text: string) => text,
	bg: (name: string, text: string) => {
		const start = name === "toolSuccessBg" ? successBg : "\x1b[48;2;40;40;50m";
		return `${start}${text}${bgReset}`;
	},
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

describe("render helpers", () => {
	it("#given plain text diff #when truncating #then falls back to head and tail", () => {
		// given
		const lines = Array.from({ length: PATCH_PREVIEW_MAX_LINES + 12 }, (_, index) => `line-${index + 1}`);
		const diff = lines.join("\n");

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview).toContain("line-1");
		expect(preview).toContain(`line-${lines.length}`);
		expect(preview).toContain("…");
		expect(preview.split("\n")).toHaveLength(PATCH_PREVIEW_MAX_LINES);
	});

	it("#given huge payload #when truncating #then enforces max chars", () => {
		// given
		const diff = `${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}\nend`;

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
		expect(preview.split("\n").length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_LINES);
		expect(preview).toContain("…");
	});

	it("#given oversized changed hunk #when truncating #then keeps max chars strict", () => {
		// given
		const diff = [
			...Array.from({ length: 20 }, (_, index) => ` ${index + 1} line-${index + 1}`),
			`-21 ${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}`,
			"+21 changed",
		].join("\n");

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
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

	it("#given cached state #when clearing #then reset helper is callable", () => {
		// given/when/then
		expect(() => clearApplyPatchRenderState()).not.toThrow();
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

	it("#given partial args #when rendering call #then shows patching placeholder", () => {
		// given
		const tool = createApplyPatchTool();

		// when
		const component = tool.renderCall?.(
			{ input: "{" },
			identityTheme as never,
			{
				argsComplete: false,
				cwd: "/workspace/project",
				toolCallId: "call-1",
			} as never,
		);
		const rendered = component?.render(120).join("\n") ?? "";

		// then
		expect(rendered).toContain("apply_patch: Patching");
	});

	it("#given patch args #when rendering call #then shows paths and count", () => {
		// given
		const tool = createApplyPatchTool();
		const args = {
			input: `*** Begin Patch
*** Update File: src/a.ts
*** Add File: src/b.ts
*** End Patch`,
		};

		// when
		const component = tool.renderCall?.(
			args,
			identityTheme as never,
			{
				argsComplete: true,
				cwd: "/workspace/project",
				toolCallId: "call-2",
			} as never,
		);
		const rendered = component?.render(200).join("\n") ?? "";

		// then
		expect(rendered).toContain("apply_patch: Patching (2 files): src/a.ts, src/b.ts");
	});

	it("#given preview #when rendering result collapsed #then shows headers without diff lines", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applying patch" }],
			details: {
				preview: {
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
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			identityTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-1", args: { input: "" } } as never,
		);
		const rendered = component?.render(200).join("\n") ?? "";

		// then
		expect(rendered).toContain("• Edited src/foo.ts (+1 -1)");
		expect(rendered).not.toContain("+1 new");
	});

	it("#given expanded preview #when rendering result #then uses OpenCode-like highlighted diff rows", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applying patch" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "-1 alpha old\n+1 alpha new\n 2 same",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			markerTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-colored", args: { input: "" } } as never,
		);
		const rendered = component?.render(200).join("\n") ?? "";

		// then
		expect(rendered).toContain("<bg:toolErrorBg><fg:toolDiffRemoved>-</fg:toolDiffRemoved><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved>");
		expect(rendered).toContain("<bg:toolSuccessBg><fg:toolDiffAdded>+</fg:toolDiffAdded><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded>");
		expect(rendered).toContain("<fg:toolDiffContext> </fg:toolDiffContext><fg:muted>2</fg:muted> same");
	});

	it("#given partial progress preview #when rendering result #then shows realtime progress in pending widget", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applying patch (1/2)..." }],
			details: {
				progress: { applied: 1, failed: 0, total: 2 },
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "-1 alpha old\n+1 alpha new",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: true },
			markerTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-progress", args: { input: "" } } as never,
		);
		const rendered = component?.render(200).join("\n") ?? "";

		// then
		expect(rendered).toContain("<bg:toolPendingBg>");
		expect(rendered).toContain("<bold>Applying patch (1/2)</bold>");
		expect(rendered).toContain("• Edited src/foo.ts (+1 -1)");
		expect(rendered).toContain("<fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved>");
		expect(rendered).toContain("<fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded>");
	});

	it("#given multi-file preview #when rendering result collapsed #then shows grouped summary", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applying patch" }],
			details: {
				preview: {
					files: [
						{ filePath: "src/a.ts", operation: "update" as const, diff: "+1 one", added: 1, removed: 0 },
						{ filePath: "src/b.ts", operation: "update" as const, diff: "+1 two", added: 1, removed: 0 },
					],
					added: 2,
					removed: 0,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			identityTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-3", args: { input: "" } } as never,
		);
		const rendered = component?.render(400).join("\n") ?? "";

		// then
		expect(rendered).toContain("• Edited 2 files (+2 -0)");
		expect(rendered).toContain("└ src/a.ts (+1 -0)");
		expect(rendered).toContain("└ src/b.ts (+1 -0)");
		expect(rendered).not.toContain("+1 one");
	});

	it("#given highlighted diff row #when rendering result in success box #then outer background resumes after row reset", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applied patch" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "+1 const value = 1;",
							added: 1,
							removed: 0,
						},
					],
					added: 1,
					removed: 0,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			ansiTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-bg", args: { input: "" } } as never,
		);
		const rendered = component?.render(120).join("\n") ?? "";

		// then
		expect(rendered).toContain(`${bgReset}${successBg}`);
	});

	it("#given large preview #when rendering result expanded #then shows truncation marker", () => {
		// given
		const tool = createApplyPatchTool();
		const diff = Array.from({ length: 50 }, (_, index) => `+${index + 1} line`).join("\n");
		const result = {
			content: [{ type: "text" as const, text: "Applying patch" }],
			details: {
				preview: {
					files: [{ filePath: "src/large.ts", operation: "update" as const, diff, added: 50, removed: 0 }],
					added: 50,
					removed: 0,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			identityTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-large", args: { input: "" } } as never,
		);
		const rendered = component?.render(400).join("\n") ?? "";

		// then
		expect(rendered).toContain("• Edited src/large.ts (+50 -0)");
		expect(rendered).toContain("…");
	});
});
