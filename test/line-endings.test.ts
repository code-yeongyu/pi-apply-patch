import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatchDetailed, createApplyPatchTool } from "../src/index.js";

const tempDirectories: string[] = [];
const identityTheme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

async function workspaceWith(name: string, content: string): Promise<{ cwd: string; file: string }> {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-apply-patch-endings-"));
	tempDirectories.push(cwd);
	const file = path.join(cwd, name);
	await writeFile(file, content);
	return { cwd, file };
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("apply_patch line endings", () => {
	it("#given a CRLF file #when a line is changed and one inserted #then every line keeps CRLF", async () => {
		// given
		const { cwd, file } = await workspaceWith("lines.txt", "one\r\ntwo\r\nthree\r\n");

		// when
		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: lines.txt\n@@\n-one\n+ONE\n two\n+between\n three\n*** End Patch\n",
		);

		// then
		expect(result.failures).toEqual([]);
		expect(await readFile(file, "utf8")).toBe("ONE\r\ntwo\r\nbetween\r\nthree\r\n");
	});

	it("#given a file with mixed line endings #when one line changes #then the untouched lines keep their own endings", async () => {
		// given
		const { cwd, file } = await workspaceWith("lines.txt", "one\r\ntwo\rthree\nfour\r\n");

		// when
		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: lines.txt\n@@\n one\n two\n-three\n+THREE\n four\n*** End Patch\n",
		);

		// then
		expect(result.failures).toEqual([]);
		expect(await readFile(file, "utf8")).toBe("one\r\ntwo\rTHREE\r\nfour\r\n");
	});

	it("#given an LF file without a final newline #when updated #then it stays LF and gains the trailing newline", async () => {
		// given
		const { cwd, file } = await workspaceWith("lines.txt", "alpha\nbeta");

		// when
		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: lines.txt\n@@\n-beta\n+BETA\n*** End Patch\n",
		);

		// then
		expect(result.failures).toEqual([]);
		expect(await readFile(file, "utf8")).toBe("alpha\nBETA\n");
	});

	it("#given a context line matched only after trimming #when patched #then that source line is left exactly as it was", async () => {
		// given
		const { cwd, file } = await workspaceWith("code.ts", "const a = 1;   \r\nconst b = 2;\r\n");

		// when
		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: code.ts\n@@\n const a = 1;\n-const b = 2;\n+const b = 3;\n*** End Patch\n",
		);

		// then
		expect(result.failures).toEqual([]);
		expect(await readFile(file, "utf8")).toBe("const a = 1;   \r\nconst b = 3;\r\n");
	});

	it("#given a CRLF file #when the patch context does not match #then the failure is reported and the bytes are untouched", async () => {
		// given
		const original = "one\r\ntwo\r\n";
		const { cwd, file } = await workspaceWith("lines.txt", original);

		// when
		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: lines.txt\n@@\n-missing\n+x\n*** End Patch\n",
		);

		// then
		expect(result.appliedFiles).toEqual([]);
		expect(result.failures.map((failure) => failure.filePath)).toEqual(["lines.txt"]);
		expect(await readFile(file, "utf8")).toBe(original);
	});

	it("#given a CRLF file #when one line changes through the tool #then the shown diff counts only that line", async () => {
		// given
		const { cwd, file } = await workspaceWith("sample.txt", "keep\r\nbefore\r\nkeep too\r\n");
		const patch = "*** Begin Patch\n*** Update File: sample.txt\n@@\n-before\n+after\n*** End Patch";
		const tool = createApplyPatchTool();

		// when
		const result = await tool.execute("apply-patch-crlf-preview", { input: patch }, undefined, undefined, {
			cwd,
		} as never);
		const rendered =
			tool
				.renderResult?.(
					result,
					{ expanded: true, isPartial: false },
					identityTheme as never,
					{ cwd, toolCallId: "apply-patch-crlf-preview", args: { input: patch } } as never,
				)
				?.render(120)
				.join("\n") ?? "";

		// then
		expect(rendered).toContain("• Edited sample.txt (+1 -1)");
		expect(await readFile(file, "utf8")).toBe("keep\r\nafter\r\nkeep too\r\n");
	});
});
