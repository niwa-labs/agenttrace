import { describe, expect, it } from "vitest";
import { extractJsonObject } from "../src/pipeline/contracts.js";

describe("v2 contracts extractJsonObject (edge cases)", () => {
	it("parses a fenced json block", () => {
		expect(extractJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
	});

	it("parses a plain fence without the json language tag", () => {
		expect(extractJsonObject('```\n{"a": 1, "b": [1, 2]}\n```')).toEqual({ a: 1, b: [1, 2] });
	});

	it("parses a bare object with no fences at all", () => {
		expect(extractJsonObject('{"a": {"b": 2}}')).toEqual({ a: { b: 2 } });
	});

	it("tolerates prose before and after the fenced block", () => {
		const text = [
			"Вот результат, как просили:",
			"```json",
			'{"arcs": [], "verdict": {"status": "success", "why": "ok"}, "items": []}',
			"```",
			"Надеюсь, это поможет!",
		].join("\n");
		expect(extractJsonObject(text)).toEqual({
			arcs: [],
			verdict: { status: "success", why: "ok" },
			items: [],
		});
	});

	it("finds an unfenced object embedded in prose", () => {
		const text = 'The answer is {"a": 1, "b": {"c": 2}} as requested.';
		expect(extractJsonObject(text)).toEqual({ a: 1, b: { c: 2 } });
	});

	it("prefers the fence when prose contains decoy braces", () => {
		const text = 'Use {curly} braces:\n```json\n{"ok": true}\n```';
		expect(extractJsonObject(text)).toEqual({ ok: true });
	});

	it("recovers an object whose string value contains a nested fence", () => {
		// the lazy fence regex cuts at the inner ``` inside the string value —
		// the brace-scan candidate must still recover the full object
		const text = '```json\n{"code": "```js\\nx()\\n```", "n": 1}\n```';
		expect(extractJsonObject(text)).toEqual({ code: "```js\nx()\n```", n: 1 });
	});

	it("returns undefined when the first of two fenced blocks is invalid JSON", () => {
		const text = 'first: ```json\n{oops}\n```\nsecond: ```json\n{"ok": 1}\n```';
		expect(extractJsonObject(text)).toBeUndefined();
	});

	it("returns undefined for malformed JSON", () => {
		expect(extractJsonObject('```json\n{"a": 1\n```')).toBeUndefined();
		expect(extractJsonObject('```json\n{oops}\n```')).toBeUndefined();
		expect(extractJsonObject("not json at all")).toBeUndefined();
		expect(extractJsonObject("")).toBeUndefined();
	});

	it("returns undefined for non-object JSON (arrays, strings, null)", () => {
		expect(extractJsonObject('```json\n[{"a": 1}]\n```')).toBeUndefined();
		expect(extractJsonObject('"just a string"')).toBeUndefined();
		expect(extractJsonObject("null")).toBeUndefined();
		expect(extractJsonObject("42")).toBeUndefined();
	});
});
