import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	getLanguageFromPath,
	highlightCode,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { Type } from "typebox";
import { writeFileAtomic } from "./write-file-atomic.js";

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
	progress?: ApplyPatchProgress;
	result?: ApplyPatchResult;
};

type ApplyPatchProgress = {
	applied: number;
	failed: number;
	total: number;
};

type ApplyPatchProgressCallback = (progress: ApplyPatchProgress) => Promise<void> | void;

async function notifyApplyPatchProgress(
	onProgress: ApplyPatchProgressCallback | undefined,
	progress: ApplyPatchProgress,
): Promise<void> {
	try {
		await onProgress?.(progress);
	} catch {
		// Rendering progress must not affect patch application or recovery details.
	}
}

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

export class PatchParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchParseError";
	}
}

export class PatchApplicationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchApplicationError";
	}
}

type ApplyPatchRenderState = {
	cwd: string;
	patchText: string;
	callText: string;
	collapsed: string;
	expanded: string;
};

type ApplyPatchThemeColor =
	| "accent"
	| "error"
	| "muted"
	| "toolDiffAdded"
	| "toolDiffContext"
	| "toolDiffRemoved"
	| "toolOutput"
	| "toolTitle";

type ApplyPatchThemeBg = "toolErrorBg" | "toolPendingBg" | "toolSuccessBg";

type ApplyPatchTheme = {
	fg: (name: ApplyPatchThemeColor, text: string) => string;
	bg: (name: ApplyPatchThemeBg, text: string) => string;
	bold: (text: string) => string;
	inverse: (text: string) => string;
};

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

const GPT_APPLY_PATCH_PROVIDERS = new Set(["openai", "openai-codex", "azure-openai-responses", "github-copilot"]);
export const PATCH_PREVIEW_MAX_LINES = 16;
export const PATCH_PREVIEW_MAX_CHARS = 4000;
const PATCH_PREVIEW_HEAD_LINES = 8;
const PATCH_PREVIEW_TAIL_LINES = PATCH_PREVIEW_MAX_LINES - PATCH_PREVIEW_HEAD_LINES - 1;
const PATCH_PREVIEW_TRUNCATION_MARKER = "…";
const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();

function applyLayeredBackground(theme: ApplyPatchTheme, bgName: ApplyPatchThemeBg, text: string): string {
	const marker = "\x1fpi-bg-marker\x1f";
	const wrappedMarker = theme.bg(bgName, marker);
	const markerIndex = wrappedMarker.indexOf(marker);
	if (markerIndex === -1) {
		return theme.bg(bgName, text);
	}

	const bgStart = wrappedMarker.slice(0, markerIndex);
	const bgEnd = wrappedMarker.slice(markerIndex + marker.length);
	const restored = text.replace(/\x1b\[([0-9;]*)m/g, (sequence: string, params: string) => {
		if (params === "" || params.split(";").some((param) => param === "0" || param === "49")) {
			return `${sequence}${bgStart}`;
		}
		return sequence;
	});
	return `${bgStart}${restored}${bgEnd}`;
}

function isChangedPreviewLine(line: string): boolean {
	return /^[+-]\s*\d+\s/.test(line);
}

function countWindowLines(lines: string[], start: number, end: number): number {
	return end - start + (start > 0 ? 1 : 0) + (end < lines.length ? 1 : 0);
}

function formatPreviewWindow(lines: string[], start: number, end: number): string {
	const previewLines = lines.slice(start, end);
	if (start > 0) {
		previewLines.unshift("…");
	}
	if (end < lines.length) {
		previewLines.push("…");
	}
	return previewLines.join("\n");
}

function createChangedHunkPreview(lines: string[]): string | undefined {
	const firstChangedLine = lines.findIndex(isChangedPreviewLine);
	if (firstChangedLine === -1) {
		return undefined;
	}

	let start = firstChangedLine;
	let end = firstChangedLine + 1;
	while (end < lines.length) {
		const line = lines[end];
		if (line === undefined || !isChangedPreviewLine(line)) {
			break;
		}
		end++;
	}

	const changedHunkEnd = end;
	while (end > start && countWindowLines(lines, start, end) > PATCH_PREVIEW_MAX_LINES) {
		end--;
	}

	while (countWindowLines(lines, start, end) < PATCH_PREVIEW_MAX_LINES) {
		const canAddBefore = start > 0;
		const canAddAfter = end < lines.length;
		if (!canAddBefore && !canAddAfter) {
			break;
		}

		const beforeContextLines = firstChangedLine - start;
		const afterContextLines = end - changedHunkEnd;
		if (canAddBefore && (!canAddAfter || beforeContextLines <= afterContextLines)) {
			start--;
		} else {
			end++;
		}
	}

	return formatPreviewWindow(lines, start, end);
}

function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	let lines = 1;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) {
			lines += 1;
		}
	}
	return lines;
}

function enforcePreviewCharLimit(preview: string): string {
	if (preview.length <= PATCH_PREVIEW_MAX_CHARS) {
		return preview;
	}

	return `${preview.slice(0, PATCH_PREVIEW_MAX_CHARS - PATCH_PREVIEW_TRUNCATION_MARKER.length).trimEnd()}${PATCH_PREVIEW_TRUNCATION_MARKER}`;
}

export function truncatePreview(text: string): string {
	if (text.length <= PATCH_PREVIEW_MAX_CHARS && countLines(text) <= PATCH_PREVIEW_MAX_LINES) {
		return text;
	}

	const lines = text.split("\n");
	const changedHunkPreview = createChangedHunkPreview(lines);
	const previewText =
		changedHunkPreview ??
		[...lines.slice(0, PATCH_PREVIEW_HEAD_LINES), "…", ...lines.slice(-PATCH_PREVIEW_TAIL_LINES)].join("\n");
	return enforcePreviewCharLimit(previewText);
}

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
	const matchesPrepared = (index: number, preparedLines: string[], preparedPattern: string[]): boolean => {
		for (let patternIndex = 0; patternIndex < preparedPattern.length; patternIndex++) {
			const line = preparedLines[index + patternIndex];
			const expected = preparedPattern[patternIndex];
			if (line === undefined || expected === undefined || line !== expected) {
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
	const linesTrimEnd = lines.map((line) => line.trimEnd());
	const patternTrimEnd = pattern.map((line) => line.trimEnd());
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesTrimEnd, patternTrimEnd)) {
			return { index, fuzz: 1 };
		}
	}
	const linesTrim = lines.map((line) => line.trim());
	const patternTrim = pattern.map((line) => line.trim());
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesTrim, patternTrim)) {
			return { index, fuzz: 100 };
		}
	}
	const linesNormalized = lines.map(normalizeSeekLine);
	const patternNormalized = pattern.map(normalizeSeekLine);
	for (let index = searchStart; index <= lastStart; index++) {
		if (matchesPrepared(index, linesNormalized, patternNormalized)) {
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
		if (hasErrorCode(error, "ENOENT")) {
			return "";
		}
		throw error;
	}
}

function formatLineCountSummary(added: number, removed: number): string {
	return `(+${added} -${removed})`;
}

function formatPatchFileSummary(file: ApplyPatchPreviewFile, cwd: string): string {
	return `${formatPatchFilePath(file, cwd)} ${formatLineCountSummary(file.added, file.removed)}`;
}

function formatPatchFileHeader(file: ApplyPatchPreviewFile, cwd: string): string {
	return `• ${formatPatchOperation(file.operation)} ${formatPatchFileSummary(file, cwd)}`;
}

function normalizeDisplayPath(filePath: string): string {
	return filePath.replaceAll(path.sep, "/");
}

export function displayPath(filePath: string, cwd: string): string {
	if (!path.isAbsolute(filePath)) {
		return normalizeDisplayPath(filePath);
	}

	const absoluteCwd = path.resolve(cwd);
	const relativePath = path.relative(absoluteCwd, filePath);
	if (
		relativePath === "" ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
	) {
		return normalizeDisplayPath(relativePath || ".");
	}

	return normalizeDisplayPath(filePath);
}

export function formatPatchFilePath(file: ApplyPatchPreviewFile, cwd: string = process.cwd()): string {
	const filePath = displayPath(file.filePath, cwd);
	if (!file.movePath) {
		return filePath;
	}
	return `${filePath} → ${displayPath(file.movePath, cwd)}`;
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

export function formatPatchPreview(
	preview: ApplyPatchPreview,
	cwd: string = process.cwd(),
	expanded: boolean = true,
): string {
	const lines: string[] = [];
	if (preview.files.length === 1) {
		const file = preview.files[0];
		if (file) {
			lines.push(formatPatchFileHeader(file, cwd));
			if (expanded && file.diff) {
				lines.push(
					...truncatePreview(file.diff)
						.split("\n")
						.map((line) => `  ${line}`),
				);
			}
		}
		return lines.join("\n");
	}

	const noun = "files";
	lines.push(`• Edited ${preview.files.length} ${noun} ${formatLineCountSummary(preview.added, preview.removed)}`);
	for (const file of preview.files) {
		lines.push(`  └ ${formatPatchFileSummary(file, cwd)}`);
		if (expanded && file.diff) {
			lines.push(
				...truncatePreview(file.diff)
					.split("\n")
					.map((line) => `    ${line}`),
			);
		}
	}
	return lines.join("\n");
}

function getApplyPatchRenderState(toolCallId: string, cwd: string, patchText: string): ApplyPatchRenderState {
	const existing = applyPatchRenderStates.get(toolCallId);
	if (existing && existing.cwd === cwd && existing.patchText === patchText) {
		return existing;
	}

	const callText = formatInFlightCallText(patchText);
	let collapsed = "";
	let expanded = "";
	try {
		const hunks = parsePatch(patchText);
		if (hunks.length > 0) {
			const files = hunks.map((hunk) => {
				const file = {
					filePath: hunk.filePath,
					operation: hunk.type,
					diff: "",
					added: 0,
					removed: 0,
				} satisfies ApplyPatchPreviewFile;
				return hunk.type === "update" && hunk.movePath !== undefined ? { ...file, movePath: hunk.movePath } : file;
			}) satisfies ApplyPatchPreviewFile[];
			const preview: ApplyPatchPreview = { files, added: 0, removed: 0 };
			collapsed = formatPatchPreview(preview, cwd, false);
			expanded = formatPatchPreview(preview, cwd, true);
		}
	} catch {
		// leave summaries empty for partial/incomplete patch text
	}

	const nextState: ApplyPatchRenderState = { cwd, patchText, callText, collapsed, expanded };
	applyPatchRenderStates.set(toolCallId, nextState);
	return nextState;
}

export function clearApplyPatchRenderState(): void {
	applyPatchRenderStates.clear();
}

export function formatInFlightCallText(patchText: string): string {
	const paths = extractPatchedPaths(patchText);
	if (paths.length === 0) {
		return "Patching";
	}
	const noun = paths.length === 1 ? "file" : "files";
	const count = paths.length > 1 ? ` (${paths.length} ${noun})` : "";
	return `Patching${count}: ${paths.join(", ")}`;
}

type RenderableAddedDiffLine = { content: string; kind: "added"; lineNumber: string; sign: "+" };
type RenderableRemovedDiffLine = { content: string; kind: "removed"; lineNumber: string; sign: "-" };
type RenderableContextDiffLine = { content: string; kind: "context"; lineNumber: string; sign: " " };
type RenderableContentDiffLine = RenderableAddedDiffLine | RenderableContextDiffLine | RenderableRemovedDiffLine;
type RenderableDiffLine = RenderableContentDiffLine | { kind: "meta"; text: string };

function parseRenderableDiffLine(line: string): RenderableDiffLine {
	const match = line.match(/^([+\- ])(\s*\d+)\s(.*)$/);
	if (!match) {
		return { kind: "meta", text: line };
	}

	const sign = match[1];
	const lineNumber = match[2];
	if ((sign !== "+" && sign !== "-" && sign !== " ") || lineNumber === undefined) {
		return { kind: "meta", text: line };
	}

	const content = match[3] ?? "";
	if (sign === "+") {
		return { content, kind: "added", lineNumber, sign };
	}
	if (sign === "-") {
		return { content, kind: "removed", lineNumber, sign };
	}
	return { content, kind: "context", lineNumber, sign };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function highlightDiffContent(content: string, filePath: string): string {
	const plainContent = replaceTabs(content);
	const language = getLanguageFromPath(filePath);
	try {
		return highlightCode(plainContent, language)[0] ?? plainContent;
	} catch {
		return plainContent;
	}
}

function renderInlineDiff(
	oldContent: string,
	newContent: string,
	theme: ApplyPatchTheme,
): { added: string; removed: string } {
	const parts = Diff.diffWords(replaceTabs(oldContent), replaceTabs(newContent));
	let added = "";
	let removed = "";
	let firstAdded = true;
	let firstRemoved = true;

	for (const part of parts) {
		if (part.added) {
			let value = part.value;
			if (firstAdded) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				added += leadingWhitespace;
				value = value.slice(leadingWhitespace.length);
				firstAdded = false;
			}
			if (value) {
				added += theme.inverse(value);
			}
			continue;
		}

		if (part.removed) {
			let value = part.value;
			if (firstRemoved) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				removed += leadingWhitespace;
				value = value.slice(leadingWhitespace.length);
				firstRemoved = false;
			}
			if (value) {
				removed += theme.inverse(value);
			}
			continue;
		}

		added += part.value;
		removed += part.value;
	}

	return { added, removed };
}

function renderOpenCodeLikeDiffLine(
	line: RenderableContentDiffLine,
	filePath: string,
	theme: ApplyPatchTheme,
	contentOverride?: string,
): string {
	const lineNumber = theme.fg("muted", line.lineNumber);
	if (line.kind === "context") {
		return `${theme.fg("toolDiffContext", line.sign)}${lineNumber} ${highlightDiffContent(line.content, filePath)}`;
	}

	const diffColor = line.kind === "added" ? "toolDiffAdded" : "toolDiffRemoved";
	const background = line.kind === "added" ? "toolSuccessBg" : "toolErrorBg";
	const content =
		contentOverride === undefined
			? highlightDiffContent(line.content, filePath)
			: theme.fg(diffColor, replaceTabs(contentOverride));
	const rendered = `${theme.fg(diffColor, line.sign)}${lineNumber} ${content}`;
	return theme.bg(background, rendered);
}

function renderOpenCodeLikeDiff(diffText: string, filePath: string, theme: ApplyPatchTheme): string {
	const parsedLines = diffText.split("\n").map(parseRenderableDiffLine);
	const rendered: string[] = [];
	let index = 0;

	while (index < parsedLines.length) {
		const line = parsedLines[index];
		if (!line) {
			index++;
			continue;
		}

		if (line.kind !== "removed") {
			rendered.push(
				line.kind === "meta"
					? theme.fg("toolDiffContext", line.text)
					: renderOpenCodeLikeDiffLine(line, filePath, theme),
			);
			index++;
			continue;
		}

		const removedLines: RenderableRemovedDiffLine[] = [];
		while (parsedLines[index]?.kind === "removed") {
			const removedLine = parsedLines[index];
			if (removedLine?.kind === "removed") {
				removedLines.push(removedLine);
			}
			index++;
		}

		const addedLines: RenderableAddedDiffLine[] = [];
		while (parsedLines[index]?.kind === "added") {
			const addedLine = parsedLines[index];
			if (addedLine?.kind === "added") {
				addedLines.push(addedLine);
			}
			index++;
		}

		const pairedCount = Math.min(removedLines.length, addedLines.length);
		for (let pairIndex = 0; pairIndex < pairedCount; pairIndex++) {
			const removedLine = removedLines[pairIndex];
			const addedLine = addedLines[pairIndex];
			if (!removedLine || !addedLine) {
				continue;
			}

			const inline = renderInlineDiff(removedLine.content, addedLine.content, theme);
			rendered.push(renderOpenCodeLikeDiffLine(removedLine, filePath, theme, inline.removed));
			rendered.push(renderOpenCodeLikeDiffLine(addedLine, filePath, theme, inline.added));
		}

		for (const removedLine of removedLines.slice(pairedCount)) {
			rendered.push(renderOpenCodeLikeDiffLine(removedLine, filePath, theme));
		}
		for (const addedLine of addedLines.slice(pairedCount)) {
			rendered.push(renderOpenCodeLikeDiffLine(addedLine, filePath, theme));
		}
	}

	return rendered.join("\n");
}

function renderPatchPreview(
	preview: ApplyPatchPreview,
	cwd: string,
	theme: ApplyPatchTheme,
	expanded: boolean,
): string {
	if (expanded) {
		try {
			const renderFile = (file: ApplyPatchPreviewFile, headerPrefix: string): string => {
				const header = formatPatchFileHeader(file, cwd);
				if (!file.diff) {
					return headerPrefix.length > 0 ? `${headerPrefix}${formatPatchFileSummary(file, cwd)}` : header;
				}
				const previewDiff = truncatePreview(file.diff);
				const renderedDiff = renderOpenCodeLikeDiff(previewDiff, file.movePath ?? file.filePath, theme);
				if (headerPrefix.length > 0) {
					const nestedHeader = `${headerPrefix}${formatPatchFileSummary(file, cwd)}`;
					return `${nestedHeader}\n${renderedDiff
						.split("\n")
						.map((line) => `    ${line}`)
						.join("\n")}`;
				}
				return `${header}\n${renderedDiff}`;
			};

			if (preview.files.length === 1) {
				const file = preview.files[0];
				return file ? renderFile(file, "") : "";
			}

			const noun = "files";
			const renderedFiles = preview.files.map((file) => renderFile(file, "  └ ")).join("\n");
			if (renderedFiles.length > 0) {
				return `• Edited ${preview.files.length} ${noun} ${formatLineCountSummary(preview.added, preview.removed)}\n${renderedFiles}`;
			}
		} catch {
			// fall back to manual themed line rendering
		}
	}

	return formatPatchPreview(preview, cwd, expanded)
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
		const absolutePath = await resolvePatchPath(cwd, hunk.filePath);
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
			await resolvePatchPath(cwd, hunk.movePath);
		}
		const diff = createPatchDiff(oldContent, newContent);
		const file = { filePath: hunk.filePath, operation: "update", ...diff } satisfies ApplyPatchPreviewFile;
		files.push(hunk.movePath !== undefined ? { ...file, movePath: hunk.movePath } : file);
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
		throw new PatchParseError("Invalid patch format: expected *** Begin Patch ... *** End Patch envelope");
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
					throw new PatchParseError(`Invalid patch format: Add File lines must start with '+'`);
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
					throw new PatchParseError(`Expected update hunk to start with a @@ context marker, got: '${nextLine}'`);
				}

				const oldLines: string[] = [];
				const newLines: string[] = [];
				let isEndOfFile = false;
				let parsedLines = 0;
				while (index < endIndex) {
					const hunkLine = lines[index] ?? "";
					if (hunkLine === "*** End of File") {
						if (parsedLines === 0) {
							throw new PatchParseError("Update hunk does not contain any lines");
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
						throw new PatchParseError(
							`Unexpected line found in update hunk: '${hunkLine}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
						);
					}
					parsedLines++;
					index++;
				}

				if (parsedLines === 0) {
					throw new PatchParseError("Update hunk does not contain any lines");
				}
				chunks.push({ changeContexts, oldLines, newLines, isEndOfFile });
			}
			if (chunks.length === 0 && !movePath) {
				throw new PatchParseError(`Update file hunk for path '${filePath}' is empty`);
			}

			hunks.push(
				movePath !== undefined
					? { type: "update", filePath, movePath, chunks }
					: { type: "update", filePath, chunks },
			);
			continue;
		}

		throw new PatchParseError(
			`'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		);
	}

	return hunks;
}

function parseNonEmptyPatch(patchText: string): ParsedPatch[] {
	const hunks = parsePatch(patchText);
	if (hunks.length > 0) {
		return hunks;
	}

	const normalized = normalizePatchText(patchText).trim();
	if (normalized === "*** Begin Patch\n*** End Patch") {
		throw new PatchParseError("patch rejected: empty patch");
	}
	throw new PatchParseError("apply_patch verification failed: no hunks found");
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
				throw new PatchApplicationError(`Failed to find context '${changeContext}' in ${filePath}`);
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
			throw new PatchApplicationError(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
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
	const absolutePath = await resolvePatchPath(cwd, hunk.filePath);
	if (hunk.type === "add") {
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFileAtomic(absolutePath, hunk.content);
		return { summary: `add: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0 };
	}

	if (hunk.type === "delete") {
		await stat(absolutePath);
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
		const absoluteMovePath = await resolvePatchPath(cwd, hunk.movePath);
		await mkdir(path.dirname(absoluteMovePath), { recursive: true });
		await writeFileAtomic(absoluteMovePath, nextContent);
		if (absoluteMovePath !== absolutePath) {
			await rm(absolutePath);
		}
		return {
			summary: `move: ${hunk.filePath} -> ${hunk.movePath}`,
			appliedFile: hunk.movePath,
			fuzz: chunkResult.fuzz,
		};
	}

	await writeFileAtomic(absolutePath, nextContent);
	return { summary: `update: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: chunkResult.fuzz };
}

export async function applyPatchDetailed(
	cwd: string,
	patchText: string,
	onProgress?: ApplyPatchProgressCallback,
): Promise<ApplyPatchResult> {
	return applyParsedPatchDetailed(cwd, parseNonEmptyPatch(patchText), onProgress);
}

async function applyParsedPatchDetailed(
	cwd: string,
	hunks: ParsedPatch[],
	onProgress?: ApplyPatchProgressCallback,
): Promise<ApplyPatchResult> {
	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	const failures: ApplyPatchFailure[] = [];
	let fuzz = 0;

	for (const hunk of hunks) {
		try {
			const { summary, appliedFile, fuzz: hunkFuzz } = await applySingleHunk(cwd, hunk);
			summaries.push(summary);
			appliedFiles.push(appliedFile);
			fuzz += hunkFuzz;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push({ filePath: hunk.filePath, operation: hunk.type, message });
		}
		await notifyApplyPatchProgress(onProgress, {
			applied: appliedFiles.length,
			failed: failures.length,
			total: hunks.length,
		});
	}

	const result: ApplyPatchResult = {
		summaries,
		appliedFiles,
		failures,
		hasPartialSuccess: appliedFiles.length > 0 && failures.length > 0,
		recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [] },
		details: { fuzz },
	};
	result.recoveryInstructions = createRecoveryInstructions(result);
	return result;
}

function createRecoveryInstructions(
	result: Pick<ApplyPatchResult, "appliedFiles" | "failures">,
): ApplyPatchRecoveryInstructions {
	const mustReadFiles = [...new Set(result.failures.map((failure) => failure.filePath))];
	const mustReadFileSet = new Set(mustReadFiles);
	const mustNotReadFiles = [...new Set(result.appliedFiles.filter((filePath) => !mustReadFileSet.has(filePath)))];
	return { mustReadFiles, mustNotReadFiles };
}

export async function applyPatch(cwd: string, patchText: string): Promise<string[]> {
	const hunks = parseNonEmptyPatch(patchText);

	const summaries: string[] = [];
	const appliedFiles: string[] = [];
	for (const hunk of hunks) {
		try {
			const { summary, appliedFile } = await applySingleHunk(cwd, hunk);
			summaries.push(summary);
			appliedFiles.push(appliedFile);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failure = { filePath: hunk.filePath, operation: hunk.type, message } satisfies ApplyPatchFailure;
			const result: ApplyPatchResult = {
				summaries,
				appliedFiles,
				failures: [failure],
				hasPartialSuccess: appliedFiles.length > 0,
				recoveryInstructions: createRecoveryInstructions({
					appliedFiles,
					failures: [failure],
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
	progress?: ApplyPatchProgress,
	previewOverride?: ApplyPatchPreview,
	parsedHunks?: ParsedPatch[],
): Promise<{ text: string; details: ApplyPatchToolDetails | undefined }> {
	const title = progress
		? `Applying patch (${progress.applied + progress.failed}/${progress.total})...`
		: "Applying patch...";
	if (previewOverride) {
		const details: ApplyPatchToolDetails = { preview: previewOverride };
		if (progress) details.progress = progress;
		return {
			text: `${title}\n${formatPatchPreview(previewOverride, cwd)}`,
			details,
		};
	}

	try {
		const hunks = parsedHunks ?? parsePatch(patchText);
		if (hunks.length === 0) {
			return { text: title, details: progress ? { progress } : undefined };
		}

		const preview = await createPatchPreview(cwd, hunks);
		if (preview.files.some((file) => file.diff.trim().length > 0)) {
			const details: ApplyPatchToolDetails = { preview };
			if (progress) details.progress = progress;
			return { text: `${title}\n${formatPatchPreview(preview, cwd)}`, details };
		}
	} catch {
		return {
			text: progress ? title : formatPendingPatchPaths(patchText),
			details: progress ? { progress } : undefined,
		};
	}

	return { text: progress ? title : formatPendingPatchPaths(patchText), details: progress ? { progress } : undefined };
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

function isPathWithinWorkspace(workspacePath: string, candidatePath: string): boolean {
	const relativePath = path.relative(workspacePath, candidatePath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
	);
}

async function findExistingAncestor(directoryPath: string, workspacePath: string): Promise<string> {
	let currentPath = directoryPath;
	while (isPathWithinWorkspace(workspacePath, currentPath)) {
		try {
			await stat(currentPath);
			return currentPath;
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw error;
			}
		}

		const parentPath = path.dirname(currentPath);
		if (parentPath === currentPath) {
			break;
		}
		currentPath = parentPath;
	}

	throw new PatchApplicationError(`Patch path escapes workspace: ${directoryPath}`);
}

async function resolvePatchPath(cwd: string, filePath: string): Promise<string> {
	const workspacePath = await realpath(cwd);
	const absolutePath = path.resolve(workspacePath, filePath);
	if (!isPathWithinWorkspace(workspacePath, absolutePath)) {
		throw new PatchApplicationError(`Patch path escapes workspace: ${filePath}`);
	}

	const existingAncestor = await findExistingAncestor(path.dirname(absolutePath), workspacePath);
	const realAncestor = await realpath(existingAncestor);
	if (!isPathWithinWorkspace(workspacePath, realAncestor)) {
		throw new PatchApplicationError(`Patch path escapes workspace: ${filePath}`);
	}

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

			let parsedHunks: ParsedPatch[] | undefined;
			try {
				parsedHunks = parseNonEmptyPatch(normalizedParams.input);
			} catch {
				// createPendingPatchUpdate keeps incomplete or invalid patch text renderable.
			}
			const totalOperations = parsedHunks?.length ?? 0;
			const initialProgress = totalOperations > 0 ? { applied: 0, failed: 0, total: totalOperations } : undefined;
			const pendingUpdate = await createPendingPatchUpdate(
				ctx.cwd,
				normalizedParams.input,
				initialProgress,
				undefined,
				parsedHunks,
			);
			onUpdate?.({
				content: [{ type: "text", text: pendingUpdate.text }],
				details: pendingUpdate.details,
			});

			const preview = pendingUpdate.details?.preview;
			const result = await applyParsedPatchDetailed(
				ctx.cwd,
				parsedHunks ?? parseNonEmptyPatch(normalizedParams.input),
				async (progress) => {
					const progressUpdate = await createPendingPatchUpdate(
						ctx.cwd,
						normalizedParams.input,
						progress,
						preview,
						parsedHunks,
					);
					onUpdate?.({
						content: [{ type: "text", text: progressUpdate.text }],
						details: progressUpdate.details,
					});
				},
			);
			if (result.failures.length > 0) {
				const mustReadFiles = result.recoveryInstructions.mustReadFiles;
				const failed = mustReadFiles.join(", ");
				const mustReadText = mustReadFiles.join(" and ");
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
		renderCall(args, theme, context) {
			if (!context.argsComplete) {
				return new Text(theme.fg("toolTitle", theme.bold("apply_patch: Patching")), 0, 0);
			}

			const normalizedArgs = normalizeApplyPatchArguments(args);
			const renderState = getApplyPatchRenderState(context.toolCallId, context.cwd, normalizedArgs.input);
			const text = renderState.callText.length > 0 ? `apply_patch: ${renderState.callText}` : "apply_patch";
			return new Text(theme.fg("toolTitle", theme.bold(text)), 0, 0);
		},
		renderResult(result, options, theme, context) {
			const component = new Container();
			const preview = result.details?.preview;
			if (preview) {
				const bgName = options.isPartial ? "toolPendingBg" : "toolSuccessBg";
				const progress = result.details?.progress;
				const title = progress
					? `Applying patch (${progress.applied + progress.failed}/${progress.total})`
					: "Applying patch";
				const box = new Box(1, 1, (text: string) => applyLayeredBackground(theme, bgName, text));
				box.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));
				box.addChild(new Spacer(1));
				const expanded = options.isPartial ? true : (options.expanded ?? true);
				box.addChild(new Text(renderPatchPreview(preview, context.cwd, theme, expanded), 0, 0));
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
