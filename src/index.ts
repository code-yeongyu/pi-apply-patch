import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";
import * as Diff from "diff";
import { Type } from "typebox";

const APPLY_PATCH_PARAMS = Type.Object({
	input: Type.String({
		description: "The entire contents of the apply_patch command",
	}),
});

type ParsedPatch =
	| { type: "add"; filePath: string; content: string }
	| { type: "delete"; filePath: string }
	| { type: "update"; filePath: string; movePath?: string; chunks: PatchChunk[] };

type PatchChunk = {
	changeContexts: string[];
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
};

type BaselineState = {
	nonGptToolNames: string[];
};

export type FreeformToolFormat = {
	type: "grammar";
	syntax: "lark";
	definition: string;
};

type ApplyPatchToolDefinition = ToolDefinition<typeof APPLY_PATCH_PARAMS, ApplyPatchToolDetails | undefined> & {
	freeform: FreeformToolFormat;
};

export type ApplyPatchExtensionAPI = Pick<ExtensionAPI, "on" | "getActiveTools" | "setActiveTools"> & {
	registerTool: (tool: ApplyPatchToolDefinition) => void;
};

type ApplyPatchParams = {
	input: string;
};

type ApplyPatchOperation = "add" | "delete" | "update";

type ApplyPatchPreviewFile = {
	filePath: string;
	movePath?: string;
	operation: ApplyPatchOperation;
	diff: string;
	added: number;
	removed: number;
};

type ApplyPatchPreview = {
	files: ApplyPatchPreviewFile[];
	added: number;
	removed: number;
};

type ApplyPatchToolDetails = {
	preview?: ApplyPatchPreview;
	result?: ApplyPatchResult;
};

export type ApplyPatchFailure = {
	filePath: string;
	operation: ApplyPatchOperation;
	message: string;
};

export type ApplyPatchRecoveryInstructions = {
	mustReadFiles: string[];
	mustNotReadFiles: string[];
};

export type ApplyPatchResult = {
	summaries: string[];
	appliedFiles: string[];
	failures: ApplyPatchFailure[];
	hasPartialSuccess: boolean;
	recoveryInstructions: ApplyPatchRecoveryInstructions;
	details: {
		fuzz: number;
	};
};

export class ApplyPatchError extends Error {
	public readonly failures: ApplyPatchFailure[];
	public readonly result: ApplyPatchResult;

	constructor(message: string, result: ApplyPatchResult) {
		super(message);
		this.name = "ApplyPatchError";
		this.failures = result.failures;
		this.result = result;
	}

	hasPartialSuccess(): boolean {
		return this.result.hasPartialSuccess;
	}
}

type ApplyPatchThemeColor =
	| "accent"
	| "error"
	| "muted"
	| "toolDiffAdded"
	| "toolDiffContext"
	| "toolDiffRemoved"
	| "toolOutput"
	| "toolTitle";

type ApplyPatchTheme = {
	fg: (name: ApplyPatchThemeColor, text: string) => string;
	bg: (name: "toolPendingBg" | "toolSuccessBg", text: string) => string;
	bold: (text: string) => string;
	inverse: (text: string) => string;
};

const GPT_APPLY_PATCH_PROVIDERS = new Set(["openai", "azure-openai-responses", "github-copilot"]);

function normalizeApplyPatchArguments(args: unknown): ApplyPatchParams {
	if (typeof args === "string") {
		return { input: args };
	}

	if (args && typeof args === "object" && "input" in args) {
		const input = (args as { input?: unknown }).input;
		if (typeof input === "string") {
			return { input };
		}
	}

	return { input: "" };
}

const EDIT_TOOL_NAMES = new Set(["write", "edit"]);
export const APPLY_PATCH_FREEFORM_DESCRIPTION =
	"Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export const CODEX_APPLY_PATCH_DESCRIPTION =
	'Use the `apply_patch` tool to edit files.\nYour patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:\n\n*** Begin Patch\n[ one or more file sections ]\n*** End Patch\n\nWithin that envelope, you get a sequence of file operations.\nYou MUST include a header to specify the action you are taking.\nEach operation starts with one of three headers:\n\n*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).\n*** Delete File: <path> - remove an existing file. Nothing follows.\n*** Update File: <path> - patch an existing file in place (optionally with a rename).\n\nMay be immediately followed by *** Move to: <new path> if you want to rename the file.\nThen one or more “hunks”, each introduced by @@ (optionally followed by a hunk header).\nWithin a hunk each line starts with:\n\nFor instructions on [context_before] and [context_after]:\n- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change’s [context_after] lines in the second change’s [context_before] lines.\n- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:\n@@ class BaseClass\n[3 lines of pre-context]\n- [old_code]\n+ [new_code]\n[3 lines of post-context]\n\n- If a code block is repeated so many times in a class or function such that even a single `@@` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple `@@` statements to jump to the right context. For instance:\n\n@@ class BaseClass\n@@ \t def method():\n[3 lines of pre-context]\n- [old_code]\n+ [new_code]\n[3 lines of post-context]\n\nThe full grammar definition is below:\nPatch := Begin { FileOp } End\nBegin := "*** Begin Patch" NEWLINE\nEnd := "*** End Patch" NEWLINE\nFileOp := AddFile | DeleteFile | UpdateFile\nAddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }\nDeleteFile := "*** Delete File: " path NEWLINE\nUpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }\nMoveTo := "*** Move to: " newPath NEWLINE\nHunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]\nHunkLine := (" " | "-" | "+") text NEWLINE\n\nA full patch can combine several operations:\n\n*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n\nIt is important to remember:\n\n- You must include a header with your intended action (Add/Delete/Update)\n- You must prefix new lines with `+` even when creating a new file\n- File references can only be relative, NEVER ABSOLUTE.\n';

export function isOpenAIGptModel(model: Pick<Model<string>, "provider" | "id"> | undefined): boolean {
	return model !== undefined && GPT_APPLY_PATCH_PROVIDERS.has(model.provider) && model.id.startsWith("gpt-");
}

function normalizePatchText(patchText: string): string {
	return patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripHeredoc(input: string): string {
	const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	if (heredocMatch) {
		return heredocMatch[2] ?? input;
	}
	return input;
}

function normalizeSeekLine(line: string): string {
	return line
		.trim()
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
): { index: number; fuzz: 0 | 1 | 100 | 10000 } | undefined {
	if (pattern.length === 0) {
		return { index: start, fuzz: 0 };
	}
	if (pattern.length > lines.length) {
		return undefined;
	}

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const lastStart = lines.length - pattern.length;
	const matches = (index: number, compare: (left: string, right: string) => boolean): boolean => {
		for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
			const line = lines[index + patternIndex];
			const expected = pattern[patternIndex];
			if (line === undefined || expected === undefined || !compare(line, expected)) {
				return false;
			}
		}
		return true;
	};

	for (let index = searchStart; index <= lastStart; index++) {
		if (matches(index, (line, expected) => line === expected)) {
			return { index, fuzz: 0 };
		}
	}
	for (let index = searchStart; index <= lastStart; index++) {
		if (matches(index, (line, expected) => line.trimEnd() === expected.trimEnd())) {
			return { index, fuzz: 1 };
		}
	}
	for (let index = searchStart; index <= lastStart; index++) {
		if (matches(index, (line, expected) => line.trim() === expected.trim())) {
			return { index, fuzz: 100 };
		}
	}
	for (let index = searchStart; index <= lastStart; index++) {
		if (matches(index, (line, expected) => normalizeSeekLine(line) === normalizeSeekLine(expected))) {
			return { index, fuzz: 10000 };
		}
	}

	return undefined;
}

export function extractPatchedPaths(patchText: string): string[] {
	const normalized = stripHeredoc(normalizePatchText(patchText));
	const matches = normalized.matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/gm);
	return Array.from(matches, (match) => match[1] ?? "");
}

function createPatchDiff(oldContent: string, newContent: string): { diff: string; added: number; removed: number } {
	const parts = Diff.diffLines(oldContent, newContent);
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length)).length;
	const output: string[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;
	let added = 0;
	let removed = 0;

	for (const part of parts) {
		const rawLines = part.value.split("\n");
		if (rawLines[rawLines.length - 1] === "") {
			rawLines.pop();
		}

		for (const line of rawLines) {
			if (part.added) {
				output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
				newLineNum++;
				added++;
				continue;
			}

			if (part.removed) {
				output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
				oldLineNum++;
				removed++;
				continue;
			}

			output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
			oldLineNum++;
			newLineNum++;
		}
	}

	return { diff: output.join("\n"), added, removed };
}

async function readExistingFileForPreview(absolutePath: string): Promise<string> {
	try {
		return await readFile(absolutePath, "utf-8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return "";
		}
		throw error;
	}
}

function formatLineCountSummary(added: number, removed: number): string {
	return `(+${added} -${removed})`;
}

function formatPatchFilePath(file: ApplyPatchPreviewFile): string {
	return file.movePath ? `${file.filePath} → ${file.movePath}` : file.filePath;
}

function formatPatchOperation(operation: ApplyPatchOperation): string {
	if (operation === "add") {
		return "Added";
	}
	if (operation === "delete") {
		return "Deleted";
	}
	return "Edited";
}

function formatPatchPreview(preview: ApplyPatchPreview): string {
	const lines: string[] = [];
	if (preview.files.length === 1) {
		const file = preview.files[0];
		if (file) {
			lines.push(
				`• ${formatPatchOperation(file.operation)} ${formatPatchFilePath(file)} ${formatLineCountSummary(file.added, file.removed)}`,
			);
			if (file.diff) {
				lines.push(...file.diff.split("\n").map((line) => `  ${line}`));
			}
		}
		return lines.join("\n");
	}

	const noun = preview.files.length === 1 ? "file" : "files";
	lines.push(`• Edited ${preview.files.length} ${noun} ${formatLineCountSummary(preview.added, preview.removed)}`);
	for (const file of preview.files) {
		lines.push(`  └ ${formatPatchFilePath(file)} ${formatLineCountSummary(file.added, file.removed)}`);
		if (file.diff) {
			lines.push(...file.diff.split("\n").map((line) => `    ${line}`));
		}
	}
	return lines.join("\n");
}

function renderPatchPreview(preview: ApplyPatchPreview, theme: ApplyPatchTheme): string {
	return formatPatchPreview(preview)
		.split("\n")
		.map((line) => {
			const trimmed = line.trimStart();
			if (trimmed.startsWith("+")) {
				return theme.fg("toolDiffAdded", line);
			}
			if (trimmed.startsWith("-")) {
				return theme.fg("toolDiffRemoved", line);
			}
			if (trimmed.startsWith("•")) {
				return theme.fg("toolTitle", theme.bold(line));
			}
			if (trimmed.startsWith("└")) {
				return theme.fg("accent", line);
			}
			return theme.fg("toolDiffContext", line);
		})
		.join("\n");
}

function formatPendingPatchPaths(patchText: string): string {
	const paths = extractPatchedPaths(patchText);
	if (paths.length === 0) {
		return "Applying patch...";
	}
	return `Applying patch...\n${paths.map((filePath) => `• ${filePath}`).join("\n")}`;
}

async function createPatchPreview(cwd: string, hunks: ParsedPatch[]): Promise<ApplyPatchPreview> {
	const files: ApplyPatchPreviewFile[] = [];
	for (const hunk of hunks) {
		const absolutePath = await resolveWorkspacePath(cwd, hunk.filePath);
		if (hunk.type === "add") {
			const oldContent = await readExistingFileForPreview(absolutePath);
			const diff = createPatchDiff(oldContent, hunk.content);
			files.push({ filePath: hunk.filePath, operation: oldContent.length > 0 ? "update" : "add", ...diff });
			continue;
		}

		if (hunk.type === "delete") {
			const oldContent = await readFile(absolutePath, "utf-8");
			const diff = createPatchDiff(oldContent, "");
			files.push({ filePath: hunk.filePath, operation: "delete", ...diff });
			continue;
		}

		const oldContent = await readFile(absolutePath, "utf-8");
		const newContent =
			hunk.chunks.length === 0 ? oldContent : replaceChunks(oldContent, hunk.filePath, hunk.chunks).content;
		if (hunk.movePath) {
			await resolveWorkspacePath(cwd, hunk.movePath);
		}
		const diff = createPatchDiff(oldContent, newContent);
		files.push({ filePath: hunk.filePath, movePath: hunk.movePath, operation: "update", ...diff });
	}

	return {
		files,
		added: files.reduce((sum, file) => sum + file.added, 0),
		removed: files.reduce((sum, file) => sum + file.removed, 0),
	};
}

function parsePatch(patchText: string): ParsedPatch[] {
	const normalized = stripHeredoc(normalizePatchText(patchText).trim()).trim();
	const lines = normalized.split("\n");
	const beginIndex = lines[0]?.trim() === "*** Begin Patch" ? 0 : -1;
	const lastLine = lines[lines.length - 1];
	const endIndex = lastLine?.trim() === "*** End Patch" ? lines.length - 1 : -1;

	if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
		throw new Error("Invalid patch format: expected *** Begin Patch ... *** End Patch envelope");
	}

	const hunks: ParsedPatch[] = [];
	let index = beginIndex + 1;
	while (index < endIndex) {
		const line = lines[index] ?? "";
		if (!line.startsWith("*** ")) {
			index++;
			continue;
		}

		if (line.startsWith("*** Add File: ")) {
			const filePath = line.slice("*** Add File: ".length);
			index++;
			const contentLines: string[] = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? "";
				if (nextLine.startsWith("*** ")) {
					break;
				}
				if (!nextLine.startsWith("+")) {
					throw new Error(`Invalid patch format: Add File lines must start with '+'`);
				}
				contentLines.push(nextLine.slice(1));
				index++;
			}
			hunks.push({
				type: "add",
				filePath,
				content: contentLines.length === 0 ? "" : `${contentLines.join("\n")}\n`,
			});
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			hunks.push({ type: "delete", filePath: line.slice("*** Delete File: ".length) });
			index++;
			continue;
		}

		if (line.startsWith("*** Update File: ")) {
			const filePath = line.slice("*** Update File: ".length);
			index++;
			let movePath: string | undefined;
			if ((lines[index] ?? "").startsWith("*** Move to: ")) {
				movePath = (lines[index] ?? "").slice("*** Move to: ".length);
				index++;
			}

			const chunks: PatchChunk[] = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? "";
				if (nextLine.trim() === "") {
					index++;
					continue;
				}
				if (nextLine.startsWith("*** ")) {
					break;
				}

				const allowMissingContext = chunks.length === 0;
				const changeContexts: string[] = [];
				if (nextLine.startsWith("@@")) {
					while (index < endIndex) {
						const contextLine = lines[index] ?? "";
						if (contextLine === "@@") {
							index++;
							continue;
						}
						if (contextLine.startsWith("@@ ")) {
							changeContexts.push(contextLine.slice("@@ ".length));
							index++;
							continue;
						}
						break;
					}
				} else if (!allowMissingContext) {
					throw new Error(`Expected update hunk to start with a @@ context marker, got: '${nextLine}'`);
				}

				const oldLines: string[] = [];
				const newLines: string[] = [];
				let isEndOfFile = false;
				let parsedLines = 0;
				while (index < endIndex) {
					const hunkLine = lines[index] ?? "";
					if (hunkLine === "*** End of File") {
						if (parsedLines === 0) {
							throw new Error("Update hunk does not contain any lines");
						}
						isEndOfFile = true;
						index++;
						break;
					}
					if (hunkLine.startsWith("@@") || hunkLine.startsWith("*** ")) {
						break;
					}
					const prefix = hunkLine[0];
					const value = hunkLine.slice(1);
					if (prefix === undefined) {
						oldLines.push("");
						newLines.push("");
					} else if (prefix === " ") {
						oldLines.push(value);
						newLines.push(value);
					} else if (prefix === "-") {
						oldLines.push(value);
					} else if (prefix === "+") {
						newLines.push(value);
					} else if (parsedLines > 0) {
						break;
					} else {
						throw new Error(
							`Unexpected line found in update hunk: '${hunkLine}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
						);
					}
					parsedLines++;
					index++;
				}

				if (parsedLines === 0) {
					throw new Error("Update hunk does not contain any lines");
				}
				chunks.push({ changeContexts, oldLines, newLines, isEndOfFile });
			}
			if (chunks.length === 0 && !movePath) {
				throw new Error(`Update file hunk for path '${filePath}' is empty`);
			}

			hunks.push({ type: "update", filePath, movePath, chunks });
			continue;
		}

		throw new Error(
			`'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		);
	}

	return hunks;
}

function splitFileLines(content: string): string[] {
	const lines = normalizePatchText(content).split("\n");
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function replaceChunks(content: string, filePath: string, chunks: PatchChunk[]): { content: string; fuzz: number } {
	const originalLines = splitFileLines(content);
	const replacements: { start: number; oldLength: number; newLines: string[] }[] = [];
	let lineIndex = 0;
	let fuzz = 0;

	for (const chunk of chunks) {
		for (const changeContext of chunk.changeContexts) {
			const contextMatch = seekSequence(originalLines, [changeContext], lineIndex, false);
			if (contextMatch === undefined) {
				throw new Error(`Failed to find context '${changeContext}' in ${filePath}`);
			}
			fuzz += contextMatch.fuzz;
			lineIndex = contextMatch.index + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertionIndex =
				originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
			replacements.push({ start: insertionIndex, oldLength: 0, newLines: chunk.newLines });
			continue;
		}

		let pattern = chunk.oldLines;
		let newLines = chunk.newLines;
		let foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (foundAt === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newLines[newLines.length - 1] === "") {
				newLines = newLines.slice(0, -1);
			}
			foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (foundAt === undefined) {
			throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		}

		fuzz += foundAt.fuzz;
		replacements.push({ start: foundAt.index, oldLength: pattern.length, newLines });
		lineIndex = foundAt.index + pattern.length;
	}

	const nextLines = [...originalLines];
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		nextLines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
	}
	nextLines.push("");
	return { content: nextLines.join("\n"), fuzz };
}

async function applySingleHunk(
	cwd: string,
	hunk: ParsedPatch,
): Promise<{ summary: string; appliedFile: string; fuzz: number }> {
	const absolutePath = await resolveWorkspacePath(cwd, hunk.filePath);
	if (hunk.type === "add") {
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await assertWorkspacePath(cwd, absolutePath);
		await writeFile(absolutePath, hunk.content, "utf-8");
		return { summary: `add: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0 };
	}

	if (hunk.type === "delete") {
		await stat(absolutePath);
		await assertWorkspacePath(cwd, absolutePath);
		await rm(absolutePath);
		return { summary: `delete: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0 };
	}

	const currentContent = await readFile(absolutePath, "utf-8");
	const chunkResult =
		hunk.chunks.length === 0
			? { content: currentContent, fuzz: 0 }
			: replaceChunks(currentContent, hunk.filePath, hunk.chunks);
	const nextContent = chunkResult.content;

	if (hunk.movePath) {
		const absoluteMovePath = await resolveWorkspacePath(cwd, hunk.movePath);
		await mkdir(path.dirname(absoluteMovePath), { recursive: true });
		await assertWorkspacePath(cwd, absoluteMovePath);
		await writeFile(absoluteMovePath, nextContent, "utf-8");
		if (absoluteMovePath !== absolutePath) {
			await rm(absolutePath);
		}
		return {
			summary: `move: ${hunk.filePath} -> ${hunk.movePath}`,
			appliedFile: hunk.movePath,
			fuzz: chunkResult.fuzz,
		};
	}

	await assertWorkspacePath(cwd, absolutePath);
	await writeFile(absolutePath, nextContent, "utf-8");
	return { summary: `update: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: chunkResult.fuzz };
}

export async function applyPatchDetailed(cwd: string, patchText: string): Promise<ApplyPatchResult> {
	const hunks = parsePatch(patchText);
	if (hunks.length === 0) {
		const normalized = normalizePatchText(patchText).trim();
		if (normalized === "*** Begin Patch\n*** End Patch") {
			throw new Error("patch rejected: empty patch");
		}
		throw new Error("apply_patch verification failed: no hunks found");
	}

	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	const failures: ApplyPatchFailure[] = [];

	for (const hunk of hunks) {
		try {
			const { summary, appliedFile } = await applySingleHunk(cwd, hunk);
			summaries.push(summary);
			appliedFiles.push(appliedFile);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push({ filePath: hunk.filePath, operation: hunk.type, message });
		}
	}

	const result: ApplyPatchResult = {
		summaries,
		appliedFiles,
		failures,
		hasPartialSuccess: appliedFiles.length > 0 && failures.length > 0,
		recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [] },
		details: { fuzz: 0 },
	};
	result.recoveryInstructions = createRecoveryInstructions(result);
	return result;
}

function createRecoveryInstructions(
	result: Pick<ApplyPatchResult, "appliedFiles" | "failures">,
): ApplyPatchRecoveryInstructions {
	const mustReadFiles = [...new Set(result.failures.map((failure) => failure.filePath))];
	const mustNotReadFiles = [...new Set(result.appliedFiles.filter((filePath) => !mustReadFiles.includes(filePath)))];
	return { mustReadFiles, mustNotReadFiles };
}

export async function applyPatch(cwd: string, patchText: string): Promise<string[]> {
	const hunks = parsePatch(patchText);
	if (hunks.length === 0) {
		const normalized = normalizePatchText(patchText).trim();
		if (normalized === "*** Begin Patch\n*** End Patch") {
			throw new Error("patch rejected: empty patch");
		}
		throw new Error("apply_patch verification failed: no hunks found");
	}

	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	for (const hunk of hunks) {
		try {
			const { summary, appliedFile } = await applySingleHunk(cwd, hunk);
			summaries.push(summary);
			appliedFiles.push(appliedFile);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const result: ApplyPatchResult = {
				summaries,
				appliedFiles,
				failures: [{ filePath: hunk.filePath, operation: hunk.type, message }],
				hasPartialSuccess: appliedFiles.length > 0,
				recoveryInstructions: createRecoveryInstructions({
					appliedFiles,
					failures: [{ filePath: hunk.filePath, operation: hunk.type, message }],
				}),
				details: { fuzz: 0 },
			};
			throw new ApplyPatchError(message, result);
		}
	}

	return summaries;
}

async function createPendingPatchUpdate(
	cwd: string,
	patchText: string,
): Promise<{ text: string; details: ApplyPatchToolDetails | undefined }> {
	try {
		const hunks = parsePatch(patchText);
		if (hunks.length === 0) {
			return { text: "Applying patch...", details: undefined };
		}

		const preview = await createPatchPreview(cwd, hunks);
		if (preview.files.some((file) => file.diff.trim().length > 0)) {
			return { text: `Applying patch...\n${formatPatchPreview(preview)}`, details: { preview } };
		}
	} catch {
		return { text: formatPendingPatchPaths(patchText), details: undefined };
	}

	return { text: formatPendingPatchPaths(patchText), details: undefined };
}

function hasEditTools(toolNames: string[]): boolean {
	return toolNames.some((toolName) => EDIT_TOOL_NAMES.has(toolName));
}

function withoutApplyPatch(toolNames: string[]): string[] {
	return toolNames.filter((toolName) => toolName !== "apply_patch");
}

function replaceEditToolsWithApplyPatch(toolNames: string[]): string[] {
	const filteredToolNames = withoutApplyPatch(toolNames).filter((toolName) => !EDIT_TOOL_NAMES.has(toolName));
	if (!hasEditTools(toolNames)) {
		return filteredToolNames;
	}
	return [...filteredToolNames, "apply_patch"];
}

function restoreEditToolsFromBaseline(currentToolNames: string[], baselineToolNames: string[]): string[] {
	const restoredToolNames = [
		...withoutApplyPatch(currentToolNames),
		...baselineToolNames.filter((toolName) => EDIT_TOOL_NAMES.has(toolName)),
	];
	return [...new Set(restoredToolNames)];
}

function isInsideWorkspace(absoluteCwd: string, absolutePath: string): boolean {
	const relativePath = path.relative(absoluteCwd, absolutePath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
	);
}

async function assertWorkspacePath(cwd: string, absolutePath: string): Promise<void> {
	const absoluteCwd = await realpath(cwd);
	let pathToCheck = absolutePath;
	while (true) {
		try {
			const realPath = await realpath(pathToCheck);
			if (!isInsideWorkspace(absoluteCwd, realPath)) {
				throw new Error("File references must stay within the current workspace.");
			}
			return;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				const parent = path.dirname(pathToCheck);
				if (parent === pathToCheck) {
					throw error;
				}
				pathToCheck = parent;
				continue;
			}
			throw error;
		}
	}
}

async function resolveWorkspacePath(cwd: string, filePath: string): Promise<string> {
	const absoluteCwd = path.resolve(cwd);
	const absolutePath = path.resolve(absoluteCwd, filePath);
	if (!isInsideWorkspace(absoluteCwd, absolutePath)) {
		throw new Error("File references must stay within the current workspace.");
	}
	await assertWorkspacePath(cwd, absolutePath);

	return absolutePath;
}

function syncToolset(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
	model: Model<string> | undefined,
	state: BaselineState,
): void {
	const currentToolNames = pi.getActiveTools();
	if (isOpenAIGptModel(model)) {
		if (hasEditTools(currentToolNames)) {
			state.nonGptToolNames = withoutApplyPatch(currentToolNames);
		}
		pi.setActiveTools(replaceEditToolsWithApplyPatch(currentToolNames));
		return;
	}

	if (state.nonGptToolNames.length > 0) {
		const restoredToolNames = restoreEditToolsFromBaseline(currentToolNames, state.nonGptToolNames);
		state.nonGptToolNames = restoredToolNames;
		pi.setActiveTools(restoredToolNames);
		return;
	}

	state.nonGptToolNames = withoutApplyPatch(currentToolNames);
	pi.setActiveTools(state.nonGptToolNames);
}

export function createApplyPatchTool(): ApplyPatchToolDefinition {
	const tool = defineTool({
		name: "apply_patch",
		label: "ApplyPatch",
		description: APPLY_PATCH_FREEFORM_DESCRIPTION,
		parameters: APPLY_PATCH_PARAMS,
		prepareArguments: normalizeApplyPatchArguments,
		promptSnippet: "Apply Codex-format file patches with apply_patch",
		promptGuidelines: [
			"Use apply_patch for file edits instead of mutating files through bash, Python scripts, heredocs, or shell redirection.",
			"After apply_patch succeeds, do not re-read the edited files just to confirm the patch applied.",
		],
		async execute(
			_toolCallId,
			params,
			_signal,
			onUpdate,
			ctx,
		): Promise<AgentToolResult<ApplyPatchToolDetails | undefined>> {
			const normalizedParams = normalizeApplyPatchArguments(params);
			if (!normalizedParams.input) {
				throw new Error("input is required");
			}

			const pendingUpdate = await createPendingPatchUpdate(ctx.cwd, normalizedParams.input);
			onUpdate?.({
				content: [{ type: "text", text: pendingUpdate.text }],
				details: pendingUpdate.details,
			});

			const result = await applyPatchDetailed(ctx.cwd, normalizedParams.input);
			if (result.failures.length > 0) {
				const failed = result.recoveryInstructions.mustReadFiles.join(", ");
				const mustReadText = failed.includes(",") ? failed.split(", ").join(" and ") : failed;
				return {
					content: [
						{
							type: "text",
							text: [
								"apply_patch partially failed.",
								`Failed: ${failed}`,
								`Recovery: MUST read ${mustReadText} before retrying.`,
								result.appliedFiles.length > 0
									? "Earlier file actions in this patch were already applied."
									: "No file actions were applied.",
								result.recoveryInstructions.mustNotReadFiles.length > 0
									? "Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it."
									: "",
							]
								.filter((line) => line.length > 0)
								.join("\n"),
						},
					],
					details: { result },
				};
			}

			return {
				content: [{ type: "text", text: result.summaries.join("\n") }],
				details: { result },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("apply_patch")), 0, 0);
		},
		renderResult(result, options, theme) {
			const component = new Container();
			const preview = result.details?.preview;
			if (preview) {
				const bgName = options.isPartial ? "toolPendingBg" : "toolSuccessBg";
				const box = new Box(1, 1, (text: string) => theme.bg(bgName, text));
				box.addChild(new Text(theme.fg("toolTitle", theme.bold("Applying patch")), 0, 0));
				box.addChild(new Spacer(1));
				box.addChild(new Text(renderPatchPreview(preview, theme), 0, 0));
				component.addChild(box);
				return component;
			}

			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.filter((value) => typeof value === "string" && value.length > 0)
				.join("\n");
			if (text) {
				component.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
			}
			return component;
		},
	});

	return Object.assign(tool, {
		freeform: {
			type: "grammar",
			syntax: "lark",
			definition: APPLY_PATCH_LARK_GRAMMAR,
		} satisfies FreeformToolFormat,
	});
}

export function registerApplyPatchExtension(pi: ApplyPatchExtensionAPI): void {
	const state: BaselineState = {
		nonGptToolNames: [],
	};

	pi.registerTool(createApplyPatchTool());

	pi.on("session_start", async (_event, ctx) => {
		syncToolset(pi, ctx.model, state);
	});

	pi.on("model_select", async (event) => {
		syncToolset(pi, event.model, state);
	});
}

export default registerApplyPatchExtension;
