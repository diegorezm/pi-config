/**
 * Git Commit Summarizer Extension
 *
 * Summarizes staged git changes into a commit-ready note.
 *
 * Features:
 *   - /git-commit-summary - Command to summarize staged changes
 *   - git_commit_summary - Tool callable by the LLM
 *   - Uses a configured model (or falls back to a cheap model) to summarize diffs
 *   - Optionally wires into agent_end for auto-summarization after each turn
 *
 * Usage:
 *   1. Copy to ~/.pi/agent/extensions/ or .pi/extensions/
 *   2. Stage some changes: git add ...
 *   3. Run /git-commit-summary or ask the LLM "summarize my staged changes"
 *   4. Copy the generated commit message
 *
 * Requirements:
 *   - Git repository with staged changes
 *   - An available model (uses any registered model)
 */

import { type ExtensionAPI, DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { complete, getModel } from "@earendil-works/pi-ai";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// ──────────────────────────────────────
	// Configuration
	// ──────────────────────────────────────

	// Which model to prefer for summarization (must be registered).
	// Uses the first available model that matches this pattern.
	const PREFERRED_MODEL = "claude-sonnet-4-5";
	const FALLBACK_MODEL = "claude-haiku-3-5";

	// ──────────────────────────────────────
	// Helpers
	// ──────────────────────────────────────

	/**
	 * Run `git diff --staged` (or `git diff --cached`) to get staged changes.
	 * Falls back to `git diff` (unstaged) if nothing is staged.
	 */
	async function getStagedDiff(): Promise<{ diff: string; files: string[]; isStaged: boolean }> {
		// Try staged diff first
		const stagedResult = await pi.exec("git", ["diff", "--staged"]);
		const stagedDiff = stagedResult.stdout.trim();
		const stagedExitOk = stagedResult.code === 0;

		// Get the list of staged files
		const filesResult = await pi.exec("git", ["diff", "--staged", "--name-only"]);
		const files = filesResult.stdout.trim().split("\n").filter(Boolean);

		if (stagedExitOk && stagedDiff.length > 0) {
			return { diff: stagedDiff, files, isStaged: true };
		}

		// Fallback: unstaged diff
		const unstagedResult = await pi.exec("git", ["diff"]);
		const unstagedDiff = unstagedResult.stdout.trim();

		if (unstagedResult.code === 0 && unstagedDiff.length > 0) {
			const unstagedFiles = (await pi.exec("git", ["diff", "--name-only"])).stdout
				.trim()
				.split("\n")
				.filter(Boolean);
			return { diff: unstagedDiff, files: unstagedFiles, isStaged: false };
		}

		return { diff: "", files: [], isStaged: true };
	}

	/**
	 * Build a summary prompt from the diff content.
	 */
	function buildSummaryPrompt(diff: string, files: string[], isStaged: boolean): string {
		const stagedLabel = isStaged ? "staged" : "unstaged";
		const fileList = files.map((f) => `  - ${f}`).join("\n");

		return [
			`You are given the ${stagedLabel} git diff below.`,
			"",
			`Files changed (${files.length}):`,
			fileList,
			"",
			"Write a concise, commit-ready summary of the changes. Follow these conventions:",
			"",
			"- First line: a short summary (50 characters or less) in imperative mood (e.g., 'Add login feature', 'Fix null pointer in UserService')",
			"- Then a blank line",
			"- Then a bullet list of key changes with brief context (what and why, not just the code)",
			"- Use present tense, imperative form",
			"- Focus on the intent and impact of the changes, not just the mechanics",
			"- If there are breaking changes, note them with a BREAKING CHANGE marker",
			"- Keep the overall message under 30 lines total",
			"",
			"```diff",
			diff,
			"```",
		].join("\n");
	}

	/**
	 * Summarize a diff using the configured model.
	 */
	async function summarizeDiff(
		diff: string,
		files: string[],
		isStaged: boolean,
		ctx: ExtensionCommandContext,
	): Promise<{ summary: string; model: string }> {
		const prompt = buildSummaryPrompt(diff, files, isStaged);

		// Try preferred model, then fallback, then any available model
		let model =
			getModel("anthropic", PREFERRED_MODEL) ?? getModel("anthropic", FALLBACK_MODEL);

		if (!model) {
			// Fallback: try any model from any provider
			const available = await ctx.modelRegistry.getAvailable();
			if (available.length > 0) {
				model = available[0];
			}
		}

		if (!model) {
			throw new Error("No model available for summarization. Please configure an API key.");
		}

		// Get API key
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			throw new Error(`No API key available for model ${model.provider}/${model.id}`);
		}

		const messages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			},
		];

		const response = await complete(
			model,
			{ messages },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				reasoningEffort: "low",
			},
		);

		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		return { summary, model: `${model.provider}/${model.id}` };
	}

	/**
	 * Core handler: get diff, summarize, notify/return result.
	 */
	async function handleSummarize(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<{ summary: string; files: string[]; model: string }> {
		if (ctx.hasUI) {
			ctx.ui.notify("Fetching staged changes...", "info");
		}

		const { diff, files, isStaged } = await getStagedDiff();

		if (!diff) {
			const msg = "No staged or unstaged changes found. Stage some changes first with `git add`.";
			if (ctx.hasUI) {
				ctx.ui.notify(msg, "warning");
			}
			throw new Error(msg);
		}

		if (ctx.hasUI) {
			const label = isStaged ? "staged" : "unstaged";
			ctx.ui.notify(
				`Found ${files.length} ${label} file(s). Summarizing...`,
				"info",
			);
		}

		const { summary, model } = await summarizeDiff(diff, files, isStaged, ctx);

		if (ctx.hasUI) {
			ctx.ui.notify(`Summary generated using ${model}`, "success");
		}

		return { summary, files, model };
	}

	// ──────────────────────────────────────
	// Command: /git-commit-summary
	// ──────────────────────────────────────

	pi.registerCommand("git-commit-summary", {
		description: "Summarize staged git changes into a commit-ready note",
		handler: async (args, ctx) => {
			try {
				const { summary, files, model } = await handleSummarize(args, ctx);

				// Show in a notification or custom UI
				if (ctx.mode === "tui") {
					// Use custom UI to display the summary in a nice bordered view
					const mdTheme = getMarkdownTheme();
					await ctx.ui.custom((_tui, theme, _kb, done) => {
						const container = new Container();
						const border = new DynamicBorder((s: string) => theme.fg("accent", s));

						container.addChild(border);
						container.addChild(
							new Text(theme.fg("accent", theme.bold("Commit Summary")), 1, 0),
						);
						container.addChild(
							new Text(
								theme.fg("dim", `${files.length} file(s) · ${model}`),
								1,
								0,
							),
						);
						container.addChild(new Text("", 0, 0));
						container.addChild(new Markdown(summary, 1, 1, mdTheme));
						container.addChild(new Text("", 0, 0));
						container.addChild(
							new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0),
						);
						container.addChild(border);

						return {
							render: (width: number) => container.render(width),
							invalidate: () => container.invalidate(),
							handleInput: (data: string) => {
								if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
									done(undefined);
								}
							},
						};
					});
				} else if (ctx.hasUI) {
					// RPC mode — notify with the summary
					ctx.ui.notify(`Commit summary:\n${summary}`, "info");
					ctx.ui.setEditorText(summary);
				} else {
					// Print mode — just output
					console.log(summary);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (ctx.hasUI) {
					ctx.ui.notify(`Error: ${message}`, "error");
				} else {
					console.error(`Error: ${message}`);
				}
			}
		},
	});

	// ──────────────────────────────────────
	// Tool: git_commit_summary
	// ──────────────────────────────────────

	pi.registerTool({
		name: "git_commit_summary",
		label: "Git Commit Summary",
		description:
			"Summarize staged (or unstaged) git changes into a commit-ready message. " +
			"Runs `git diff --staged` to get the diff, then uses an LLM to write a concise commit summary. " +
			"Returns the summary text and the list of changed files.",
		promptSnippet: "Summarize staged git changes into a commit-ready message",
		promptGuidelines: [
			"Use git_commit_summary when the user asks to generate a commit message or summarize staged changes.",
		],
		parameters: Type.Object({
			autoCopy: Type.Optional(
				Type.Boolean({
					description:
						"If true, attempt to copy the summary to clipboard via pbcopy/xclip. Default: false",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Cancelled" }],
					isError: true,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: "Fetching staged changes..." }],
			});

			const { diff, files, isStaged } = await getStagedDiff();

			if (!diff) {
				return {
					content: [
						{
							type: "text",
							text: "No staged or unstaged changes found. Stage some changes first with `git add`.",
						},
					],
					details: { files: [], summary: "", isStaged: false },
				};
			}

			const stagedLabel = isStaged ? "staged" : "unstaged";
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Found ${files.length} ${stagedLabel} file(s). Generating summary...`,
					},
				],
			});

			const prompt = buildSummaryPrompt(diff, files, isStaged);

			// Pick a model
			let model =
				getModel("anthropic", PREFERRED_MODEL) ?? getModel("anthropic", FALLBACK_MODEL);
			if (!model) {
				const available = await ctx.modelRegistry.getAvailable();
				if (available.length > 0) model = available[0];
			}
			if (!model) {
				throw new Error("No model available for commit summary generation.");
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(`No API key for ${model.provider}/${model.id}`);
			}

			const messages = [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: prompt }],
					timestamp: Date.now(),
				},
			];

			const response = await complete(
				model,
				{ messages },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					reasoningEffort: "low",
					signal,
				},
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			// Optionally copy to clipboard
			if (params.autoCopy) {
				try {
					await pi.exec("bash", [
						"-c",
						`echo ${JSON.stringify(summary)} | (command -v pbcopy >/dev/null 2>&1 && pbcopy || command -v xclip >/dev/null 2>&1 && xclip -selection clipboard || true)`,
					]);
				} catch {
					// clipboard not available, ignore
				}
			}

			return {
				content: [
					{
						type: "text",
						text: [
							`Generated commit summary using ${model.provider}/${model.id}:`,
							"",
							summary,
							"",
							`Files: ${files.join(", ")}`,
						].join("\n"),
					},
				],
				details: {
					summary,
					files,
					model: `${model.provider}/${model.id}`,
					isStaged,
				},
			};
		},
	});
}