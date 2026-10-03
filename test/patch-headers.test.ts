import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatchDetailed, extractPatchedPaths, PatchParseError } from "../src/index.js";

const tempDirectories: string[] = [];

async function workspace(files: Record<string, string>): Promise<string> {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-apply-patch-headers-"));
	tempDirectories.push(cwd);
	for (const [name, content] of Object.entries(files)) {
		await writeFile(path.join(cwd, name), content);
	}
	return cwd;
}

async function exists(filePath: string): Promise<boolean> {
	return stat(filePath).then(
		() => true,
		() => false,
	);
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("apply_patch file headers", () => {
	it("#given an update header indented with spaces #when applied #then the file is updated like Codex", async () => {
		// given
		const cwd = await workspace({ "foo.txt": "old\n" });

		// when
		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n  *** Update File: foo.txt\n@@\n-old\n+new\n*** End Patch\n",
		);

		// then
		expect(result.failures).toEqual([]);
		expect(await readFile(path.join(cwd, "foo.txt"), "utf8")).toBe("new\n");
	});

	it("#given an indented update header after a delete section #when applied #then both files change", async () => {
		// given
		const cwd = await workspace({ "old.txt": "x\n", "b.txt": "b1\n" });

		// when
		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Delete File: old.txt\n  *** Update File: b.txt\n@@\n-b1\n+B1\n*** End Patch\n",
		);

		// then
		expect(result.failures).toEqual([]);
		expect(result.appliedFiles).toEqual(["old.txt", "b.txt"]);
		expect(await exists(path.join(cwd, "old.txt"))).toBe(false);
		expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("B1\n");
	});

	it("#given an indented header right after added file content #when applied #then the next section still applies", async () => {
		// given
		const cwd = await workspace({ "b.txt": "b1\n" });

		// when
		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Add File: new.txt\n+hello\n  *** Update File: b.txt\n@@\n-b1\n+B1\n*** End Patch\n",
		);

		// then
		expect(result.failures).toEqual([]);
		expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe("hello\n");
		expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("B1\n");
	});

	it("#given a stray line between file sections #when applied #then the whole patch is rejected and nothing changes", async () => {
		// given
		const cwd = await workspace({ "old.txt": "x\n", "b.txt": "b1\n" });
		const patch = "*** Begin Patch\n*** Delete File: old.txt\nnow update b\n@@\n-b1\n+B1\n*** End Patch\n";

		// when
		const applying = applyPatchDetailed(cwd, patch);

		// then
		await expect(applying).rejects.toThrow(PatchParseError);
		await expect(applyPatchDetailed(cwd, patch)).rejects.toThrow("'now update b' is not a valid hunk header");
		expect(await exists(path.join(cwd, "old.txt"))).toBe(true);
		expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("b1\n");
	});

	it("#given a misspelled header as the first section #when applied #then it is rejected instead of reporting no hunks", async () => {
		// given
		const cwd = await workspace({ "b.txt": "b1\n" });

		// when
		const applying = applyPatchDetailed(cwd, "*** Begin Patch\nUpdate File: b.txt\n@@\n-b1\n+B1\n*** End Patch\n");

		// then
		await expect(applying).rejects.toThrow("'Update File: b.txt' is not a valid hunk header");
		expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("b1\n");
	});

	it("#given an indented header inside an update hunk #when applied #then it is matched as a context line like Codex", async () => {
		// given
		const cwd = await workspace({ "notes.md": "intro\n *** Update File: x\nend\n" });

		// when
		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: notes.md\n@@\n intro\n  *** Update File: x\n-end\n+END\n*** End Patch\n",
		);

		// then
		expect(result.failures).toEqual([]);
		expect(await readFile(path.join(cwd, "notes.md"), "utf8")).toBe("intro\n *** Update File: x\nEND\n");
	});

	it("#given headers indented or padded with any whitespace #when applied #then the listed paths are exactly the files written", async () => {
		// given
		const cwd = await workspace({ "old.txt": "x\n", "b.txt": "b1\n", "c.txt": "c1\n" });
		const patch =
			"*** Begin Patch\n*** Delete File: old.txt\n\u00A0*** Update File: b.txt\u00A0\n@@\n-b1\n+B1\n" +
			"*** Update File: c.txt\u00A0\n*** Move to: moved.txt  \n@@\n-c1\n+C1\n*** End Patch\n";

		// when
		const listed = extractPatchedPaths(patch);
		const result = await applyPatchDetailed(cwd, patch);

		// then
		expect(result.failures).toEqual([]);
		expect(listed).toEqual(["old.txt", "b.txt", "c.txt", "moved.txt"]);
		expect(result.appliedFiles).toEqual(["old.txt", "b.txt", "moved.txt"]);
		expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("B1\n");
		expect(await readFile(path.join(cwd, "moved.txt"), "utf8")).toBe("C1\n");
		expect(await exists(path.join(cwd, "c.txt"))).toBe(false);
	});
});
