import { resolveGrammarConstrainedSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { describe, expect, it } from "vitest";
import { APPLY_PATCH_LARK_GRAMMAR, createApplyPatchTool } from "../src/index.js";

describe("apply_patch grammar tool", () => {
	it("#given a provider with OpenAI grammar tools #when pi prepares apply_patch #then it is sent as the Codex Lark grammar tool", () => {
		// given
		const tool = createApplyPatchTool();

		// when
		const grammar = resolveGrammarConstrainedSampling(tool, true);

		// then
		expect(grammar?.format).toBe("lark");
		expect(grammar?.definition).toBe(APPLY_PATCH_LARK_GRAMMAR);
		expect(grammar?.inputProperty).toBe("input");
	});

	it("#given a provider without grammar tools #when pi prepares apply_patch #then it stays a plain function tool", () => {
		// given
		const tool = createApplyPatchTool();

		// when
		const grammar = resolveGrammarConstrainedSampling(tool, false);

		// then
		expect(grammar).toBeUndefined();
	});
});
