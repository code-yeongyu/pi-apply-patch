import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	APPLY_PATCH_FREEFORM_DESCRIPTION,
	APPLY_PATCH_LARK_GRAMMAR,
	type ApplyPatchExtensionAPI,
	applyPatch,
	applyPatchDetailed,
	createApplyPatchTool,
	extractPatchedPaths,
	type FreeformToolFormat,
	isOpenAIGptModel,
	registerApplyPatchExtension,
} from "../src/index.js";

const tempDirectories: string[] = [];
const identityTheme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
};
type ApplyPatchTool = ReturnType<typeof createApplyPatchTool>;
type ApplyPatchUpdate = Parameters<NonNullable<Parameters<ApplyPatchTool["execute"]>[3]>>[0];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(process.cwd(), "test-temp-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	while (tempDirectories.length > 0) {
		const directory = tempDirectories.pop();
		if (directory) {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

describe("pi-apply-patch", () => {
	it("#given extension #when registered #then exposes codex freeform apply_patch tool", () => {
		// given
		let capturedToolName: string | undefined;
		let capturedDescription: string | undefined;
		let capturedFreeform: FreeformToolFormat | undefined;
		const extensionApi = {
			registerTool(tool: ReturnType<typeof createApplyPatchTool>) {
				capturedToolName = tool.name;
				capturedDescription = tool.description;
				capturedFreeform = tool.freeform;
			},
			on() {},
			getActiveTools() {
				return ["read", "write", "edit"];
			},
			setActiveTools() {},
		} satisfies ApplyPatchExtensionAPI;

		// when
		registerApplyPatchExtension(extensionApi);

		// then
		expect(capturedToolName).toBe("apply_patch");
		expect(capturedDescription).toBe(APPLY_PATCH_FREEFORM_DESCRIPTION);
		expect(capturedFreeform).toEqual({
			type: "grammar",
			syntax: "lark",
			definition: APPLY_PATCH_LARK_GRAMMAR,
		});
	});

	it("#given raw codex patch #when executed #then applies file update", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "sample.txt"), "before\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** End Patch`;

		// when
		await applyPatch(directory, patch);

		// then
		expect(await readFile(path.join(directory, "sample.txt"), "utf-8")).toBe("after\n");
	});

	it("#given apply_patch tool execution #when started #then emits pending TUI diff update", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "sample.txt"), "before\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** Add File: created.txt
+created
*** End Patch`;
		const tool = createApplyPatchTool();
		const updates: Array<{ text: string; update: ApplyPatchUpdate }> = [];

		// when
		await tool.execute(
			"apply-patch-test",
			{ input: patch },
			undefined,
			(update) => {
				const firstText = update.content.find((block) => block.type === "text")?.text;
				if (firstText) {
					updates.push({ text: firstText, update });
				}
			},
			{ cwd: directory } as never,
		);

		// then
		const update = updates[0];
		expect(update).toBeDefined();
		if (!update) {
			throw new Error("apply_patch did not emit a pending update");
		}
		expect(update.text).toContain("Applying patch...\n• Edited 2 files (+2 -1)");
		expect(update.text).toContain("sample.txt (+1 -1)");
		expect(update.text).toContain("-1 before");
		expect(update.text).toContain("+1 after");
		expect(update.text).toContain("created.txt (+1 -0)");
		expect(update.text).toContain("+1 created");
		expect(update.text).not.toContain("Index:");

		const component = tool.renderResult?.(
			{ content: [{ type: "text", text: update.text }], details: update.update.details },
			{ expanded: false, isPartial: true },
			identityTheme as never,
			{ lastComponent: undefined } as never,
		);
		const rendered = component?.render(120).join("\n") ?? "";
		expect(rendered).toContain("Applying patch");
		expect(rendered).toContain("• Edited 2 files (+2 -1)");
		expect(rendered).toContain("sample.txt (+1 -1)");
		expect(rendered).toContain("+1 after");
		expect(rendered).not.toContain("Index:");
	});

	it("#given add patch overwriting existing file #when started #then pending diff shows removed content", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "existing.txt"), "old\n", "utf-8");
		const patch = `*** Begin Patch
*** Add File: existing.txt
+new
*** End Patch`;
		const updates: string[] = [];

		// when
		await createApplyPatchTool().execute(
			"apply-patch-overwrite-test",
			{ input: patch },
			undefined,
			(update) => {
				const firstText = update.content.find((block) => block.type === "text")?.text;
				if (firstText) {
					updates.push(firstText);
				}
			},
			{ cwd: directory } as never,
		);

		// then
		expect(updates[0]).toContain("• Edited existing.txt (+1 -1)");
		expect(updates[0]).toContain("-1 old");
		expect(updates[0]).toContain("+1 new");
		expect(await readFile(path.join(directory, "existing.txt"), "utf-8")).toBe("new\n");
	});

	it("#given codex multi operation freeform patch #when executed #then applies all operations", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "modify.txt"), "line1\nline2\n", "utf-8");
		await writeFile(path.join(directory, "delete.txt"), "obsolete\n", "utf-8");
		const patch = `*** Begin Patch
*** Add File: nested/new.txt
+created
*** Delete File: delete.txt
*** Update File: modify.txt
@@
-line2
+changed
*** End Patch`;

		// when
		const summaries = await applyPatch(directory, patch);

		// then
		expect(summaries).toEqual(["add: nested/new.txt", "delete: delete.txt", "update: modify.txt"]);
		expect(await readFile(path.join(directory, "nested", "new.txt"), "utf-8")).toBe("created\n");
		expect(await readFile(path.join(directory, "modify.txt"), "utf-8")).toBe("line1\nchanged\n");
		await expect(readFile(path.join(directory, "delete.txt"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("#given codex patch with contextual chunks #when executed #then applies chunks in order", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "multi.txt"), "alpha\none\nbeta\ntwo\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: multi.txt
@@ alpha
-one
+ONE
@@ beta
-two
+TWO
*** End Patch`;

		// when
		await applyPatch(directory, patch);

		// then
		expect(await readFile(path.join(directory, "multi.txt"), "utf-8")).toBe("alpha\nONE\nbeta\nTWO\n");
	});

	it("#given codex patch with stacked contexts #when executed #then narrows before replacing", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(
			path.join(directory, "stacked.txt"),
			"class Alpha {\n  method() {\n    x = 1\n  }\n}\nclass Beta {\n  method() {\n    x = 1\n  }\n}\n",
			"utf-8",
		);
		const patch = `*** Begin Patch
*** Update File: stacked.txt
@@ class Beta {
@@   method() {
-    x = 1
+    x = 2
*** End Patch`;

		// when
		await applyPatch(directory, patch);

		// then
		expect(await readFile(path.join(directory, "stacked.txt"), "utf-8")).toBe(
			"class Alpha {\n  method() {\n    x = 1\n  }\n}\nclass Beta {\n  method() {\n    x = 2\n  }\n}\n",
		);
	});

	it("#given codex patch with heredoc wrapper #when executed #then strips wrapper", async () => {
		// given
		const directory = await createTempDirectory();
		const patch = `<<'EOF'
*** Begin Patch
*** Add File: heredoc.txt
+ok
*** End Patch
EOF`;

		// when
		await applyPatch(directory, patch);

		// then
		expect(await readFile(path.join(directory, "heredoc.txt"), "utf-8")).toBe("ok\n");
	});

	it("#given codex patch with end-of-file marker #when executed #then only matches file ending", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "eof.txt"), "target\nkeep\ntarget\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: eof.txt
@@
-target
+done
*** End of File
*** End Patch`;

		// when
		await applyPatch(directory, patch);

		// then
		expect(await readFile(path.join(directory, "eof.txt"), "utf-8")).toBe("target\nkeep\ndone\n");
	});

	it("#given codex patch with fuzzy context #when executed #then matches like codex", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "fuzzy.txt"), "name = “old”  \n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: fuzzy.txt
@@
-name = "old"
+name = "new"
*** End Patch`;

		// when
		await applyPatch(directory, patch);

		// then
		expect(await readFile(path.join(directory, "fuzzy.txt"), "utf-8")).toBe('name = "new"\n');
	});

	it("#given absolute workspace paths #when executed #then applies patch like codex", async () => {
		// given
		const directory = await createTempDirectory();
		const absoluteAddPath = path.join(directory, "absolute-add.txt");
		const absoluteDeletePath = path.join(directory, "absolute-delete.txt");
		const absoluteUpdatePath = path.join(directory, "absolute-update.txt");
		const absoluteMoveSourcePath = path.join(directory, "absolute-move-source.txt");
		const absoluteMoveDestinationPath = path.join(directory, "nested", "absolute-move-destination.txt");
		await writeFile(absoluteDeletePath, "delete me\n", "utf-8");
		await writeFile(absoluteUpdatePath, "before\n", "utf-8");
		await writeFile(absoluteMoveSourcePath, "move me\n", "utf-8");
		const patch = `*** Begin Patch
*** Add File: ${absoluteAddPath}
+created
*** Delete File: ${absoluteDeletePath}
*** Update File: ${absoluteUpdatePath}
@@
-before
+after
*** Update File: ${absoluteMoveSourcePath}
*** Move to: ${absoluteMoveDestinationPath}
@@
-move me
+moved
*** End Patch`;

		// when
		await applyPatch(directory, patch);

		// then
		expect(await readFile(absoluteAddPath, "utf-8")).toBe("created\n");
		await expect(readFile(absoluteDeletePath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(absoluteUpdatePath, "utf-8")).toBe("after\n");
		await expect(readFile(absoluteMoveSourcePath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(absoluteMoveDestinationPath, "utf-8")).toBe("moved\n");
	});

	it("#given rename-only codex patch #when executed #then moves file without changing content", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "old.txt"), "no trailing newline", "utf-8");
		const patch = `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
*** End Patch`;

		// when
		await applyPatch(directory, patch);

		// then
		await expect(readFile(path.join(directory, "old.txt"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(path.join(directory, "new.txt"), "utf-8")).toBe("no trailing newline");
	});

	it("#given absolute path outside workspace #when executed #then rejects patch", async () => {
		// given
		const directory = await createTempDirectory();
		const outsidePath = path.join(path.dirname(directory), "outside-apply-patch.txt");
		const patch = `*** Begin Patch
*** Add File: ${outsidePath}
+outside
*** End Patch`;

		// when / then
		await expect(applyPatch(directory, patch)).rejects.toThrow(
			"File references must stay within the current workspace.",
		);
	});

	it("#given symlink escaping workspace #when executed #then rejects patch", async () => {
		// given
		const directory = await createTempDirectory();
		const outsideDirectory = await createTempDirectory();
		await symlink(outsideDirectory, path.join(directory, "link"), "dir");
		const patch = `*** Begin Patch
*** Add File: link/outside.txt
+outside
*** End Patch`;

		// when / then
		await expect(applyPatch(directory, patch)).rejects.toThrow(
			"File references must stay within the current workspace.",
		);
	});

	it("#given invalid codex hunk header #when executed #then reports parser diagnostic", async () => {
		// given
		const directory = await createTempDirectory();
		const patch = `*** Begin Patch
*** Frobnicate File: foo
*** End Patch`;

		// when / then
		await expect(applyPatch(directory, patch)).rejects.toThrow("is not a valid hunk header");
	});

	it("#given missing codex context #when executed #then reports expected lines", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "modify.txt"), "line1\nline2\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: modify.txt
@@
-missing
+changed
*** End Patch`;

		// when / then
		await expect(applyPatch(directory, patch)).rejects.toThrow("Failed to find expected lines in modify.txt");
	});

	it("#given partial patch failure #when applying detailed #then accumulates applied and failed files", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "ok.txt"), "before\n", "utf-8");
		await writeFile(path.join(directory, "broken.txt"), "line\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: ok.txt
@@
-before
+after
*** Update File: broken.txt
@@
-missing
+changed
*** End Patch`;

		// when
		const result = await applyPatchDetailed(directory, patch);

		// then
		expect(result.appliedFiles).toEqual(["ok.txt"]);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]?.filePath).toBe("broken.txt");
		expect(result.recoveryInstructions.mustReadFiles).toEqual(["broken.txt"]);
		expect(result.recoveryInstructions.mustNotReadFiles).toEqual(["ok.txt"]);
	});

	it("#given partial patch failure #when applying compat api #then fails fast after first error", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "broken.txt"), "line\n", "utf-8");
		await writeFile(path.join(directory, "later.txt"), "before\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: broken.txt
@@
-missing
+changed
*** Update File: later.txt
@@
-before
+after
*** End Patch`;

		// when / then
		await expect(applyPatch(directory, patch)).rejects.toThrow("Failed to find expected lines in broken.txt");
		expect(await readFile(path.join(directory, "later.txt"), "utf-8")).toBe("before\n");
	});

	it("#given fuzzy matches across hunks #when applying detailed #then aggregates fuzz score", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "trim-end.txt"), "keep trailing   \n", "utf-8");
		await writeFile(path.join(directory, "normalize.txt"), "name = “old”\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: trim-end.txt
@@
-keep trailing
+keep trailing updated
*** Update File: normalize.txt
@@
-name = "old"
+name = "new"
*** End Patch`;

		// when
		const result = await applyPatchDetailed(directory, patch);

		// then
		expect(result.failures).toEqual([]);
		expect(result.details.fuzz).toBe(10001);
	});

	it("#given patch text #when extracting paths #then returns touched files", () => {
		// given
		const patch = `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** Add File: src/new.ts
+content
*** Update File: src/old.ts
*** Move to: src/moved.ts
*** End Patch`;

		// when / then
		expect(extractPatchedPaths(patch)).toEqual(["src/app.ts", "src/new.ts", "src/old.ts", "src/moved.ts"]);
	});

	it("#given model metadata #when checking GPT activation #then only OpenAI GPT models match", () => {
		expect(isOpenAIGptModel({ provider: "openai", id: "gpt-5" })).toBe(true);
		expect(isOpenAIGptModel({ provider: "openai", id: "o1" })).toBe(false);
		expect(isOpenAIGptModel({ provider: "anthropic", id: "gpt-5" })).toBe(false);
	});
});
