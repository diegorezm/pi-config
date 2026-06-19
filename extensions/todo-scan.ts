/**
 * TODO/FIXME/XXX Scanner Extension
 *
 * Scans the repository for TODO, FIXME, and XXX comments using ripgrep (rg)
 * and formats them as a markdown checklist grouped by file.
 *
 * Provides:
 * - `scan_todos` tool (for the LLM)
 * - `/scan-todos` command (for the user)
 *
 * Place in ~/.pi/agent/extensions/ or .pi/extensions/
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TodoItem {
	file: string;
	line: number;
	text: string;
	tag: "TODO" | "FIXME" | "XXX";
}

interface ScanResult {
	items: TodoItem[];
	error?: string;
}

// ---------------------------------------------------------------------------
// Scanning logic
// ---------------------------------------------------------------------------

/**
 * Run ripgrep to find TODO/FIXME/XXX comments in the repo.
 * Uses `rg` with options that skip binaries, node_modules, .git, etc.
 */
function scanRepo(cwd: string): ScanResult {
	try {
		// Check if rg is available
		execSync("which rg", { stdio: "ignore", cwd });
	} catch {
		return { items: [], error: "ripgrep (rg) not found. Install it with: apt install ripgrep / brew install ripgrep" };
	}

	// Patterns: we look for TODO, FIXME, or XXX at the start of a comment or inline.
	// We exclude .git, node_modules, and common binary/asset paths.
	const pattern = "(TODO|FIXME|XXX)[:\\s]";

	try {
		const output = execSync(
			`rg --no-heading --line-number --with-filename --color never ` +
				`--glob '!.git' --glob '!node_modules' --glob '!vendor' --glob '!.next' --glob '!dist' --glob '!build' --glob '!target' ` +
				`--glob '!*.lock' --glob '!*.sum' --glob '!*.map' ` +
				`-i "${pattern}"`,
			{ encoding: "utf-8", cwd, maxBuffer: 10 * 1024 * 1024 },
		);

		const items: TodoItem[] = [];

		for (const line of output.split("\n")) {
			if (!line.trim()) continue;

			// Parse "file:line:text"
			const match = line.match(/^(.+?):(\d+):(.+)$/);
			if (!match) continue;

			const [, file, lineNumStr, rawText] = match;
			const lineNum = parseInt(lineNumStr, 10);

			// Determine tag (case-insensitive match)
			const tagMatch = rawText.match(/\b(TODO|FIXME|XXX)\b/i);
			if (!tagMatch) continue;

			const tag = tagMatch[1].toUpperCase() as TodoItem["tag"];
			const cleaned = rawText.replace(/^\s*\/[/\*#%]*\s*/, "").trim();
			const text = cleaned.length > 120 ? cleaned.slice(0, 117) + "..." : cleaned;

			items.push({ file, line: lineNum, text, tag });
		}

		return { items };
	} catch (err) {
		// rg returns exit code 1 when no matches found
		const error = err as Error;
		if (error.message?.includes("exit code 1")) {
			return { items: [] };
		}
		return { items: [], error: `rg error: ${error.message}` };
	}
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatChecklist(items: TodoItem[]): string {
	if (items.length === 0) {
		return "✅ No TODO, FIXME, or XXX comments found in the repository.";
	}

	// Group by file
	const grouped = new Map<string, TodoItem[]>();
	for (const item of items) {
		const existing = grouped.get(item.file) ?? [];
		existing.push(item);
		grouped.set(item.file, existing);
	}

	const tagColors: Record<TodoItem["tag"], string> = {
		TODO: "🔵",
		FIXME: "🔴",
		XXX: "🟡",
	};

	const parts: string[] = [`# TODO / FIXME / XXX Checklist\n`];
	parts.push(`**Total: ${items.length} items**\n`);

	// Sort files by name
	const sortedFiles = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));

	for (const [file, fileItems] of sortedFiles) {
		parts.push(`## 📄 \`${file}\` (${fileItems.length})\n`);

		// Sort items by line number
		fileItems.sort((a, b) => a.line - b.line);

		for (const item of fileItems) {
			const icon = tagColors[item.tag];
			const link = `[\`${item.file}:${item.line}\`](${item.file}#L${item.line})`;
			parts.push(`- [ ] ${icon} **${item.tag}** (${link}) ${item.text}`);
		}
		parts.push("");
	}

	return parts.join("\n");
}

function formatSummary(items: TodoItem[]): string {
	if (items.length === 0) {
		return "No TODOs found.";
	}

	const todoCount = items.filter((i) => i.tag === "TODO").length;
	const fixmeCount = items.filter((i) => i.tag === "FIXME").length;
	const xxxCount = items.filter((i) => i.tag === "XXX").length;

	const byFile = new Set(items.map((i) => i.file));

	return [
		`Found **${items.length}** items across **${byFile.size}** files:`,
		`- 🔵 TODO: ${todoCount}`,
		`- 🔴 FIXME: ${fixmeCount}`,
		`- 🟡 XXX: ${xxxCount}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// UI Component (for /scan-todos command)
// ---------------------------------------------------------------------------

class ScanResultsComponent {
	private items: TodoItem[];
	private theme: Theme;
	private onClose: () => void;
	private scrollOffset = 0;

	constructor(items: TodoItem[], theme: Theme, onClose: () => void) {
		this.items = items;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset = Math.min(this.items.length - 1, this.scrollOffset + 1);
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " TODO / FIXME / XXX Scanner ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.items.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("success", "✅ No TODOs, FIXMEs, or XXXs found!")}`, width));
		} else {
			const todoCount = this.items.filter((i) => i.tag === "TODO").length;
			const fixmeCount = this.items.filter((i) => i.tag === "FIXME").length;
			const xxxCount = this.items.filter((i) => i.tag === "XXX").length;
			const fileCount = new Set(this.items.map((i) => i.file)).size;

			lines.push(
				truncateToWidth(
					`  ${th.fg("accent", `${this.items.length}`)} items in ${th.fg("accent", `${fileCount}`)} files  ` +
						`🔵 ${todoCount}  🔴 ${fixmeCount}  🟡 ${xxxCount}`,
					width,
				),
			);
			lines.push("");

			// Group by file for display
			const grouped = new Map<string, TodoItem[]>();
			for (const item of this.items) {
				const existing = grouped.get(item.file) ?? [];
				existing.push(item);
				grouped.set(item.file, existing);
			}

			const sortedFiles = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
			const visibleItems: { file: string; item: TodoItem }[] = [];

			for (const [file, fileItems] of sortedFiles) {
				fileItems.sort((a, b) => a.line - b.line);
				for (const item of fileItems) {
					visibleItems.push({ file, item });
				}
			}

			const tagColors: Record<TodoItem["tag"], string> = {
				TODO: "accent",
				FIXME: "error",
				XXX: "warning",
			};

			const start = this.scrollOffset;
			const end = Math.min(start + 20, visibleItems.length);

			for (let i = start; i < end; i++) {
				const { file, item } = visibleItems[i];
				const color = tagColors[item.tag];
				const icon = item.tag === "TODO" ? "○" : item.tag === "FIXME" ? "!" : "?";
				const tagStr = th.fg(color as any, th.bold(icon));
				const fileStr = th.fg("dim", `${file}:${item.line}`);
				const textStr = th.fg("muted", item.text);
				lines.push(truncateToWidth(`  ${tagStr} ${fileStr} ${textStr}`, width));
			}

			if (visibleItems.length > 20) {
				lines.push("");
				lines.push(
					truncateToWidth(
						`  ${th.fg("dim", `Showing ${start + 1}-${Math.min(end, visibleItems.length)} of ${visibleItems.length} (↑↓ to scroll)`)}`,
						width,
					),
				);
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");
		return lines;
	}

	renderScroll(width: number): string[] {
		return this.render(width);
	}

	invalidate(): void {
		// No caching needed
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// ---- Tool: scan_todos (for LLM use) ----

	pi.registerTool({
		name: "scan_todos",
		label: "Scan TODOs",
		description:
			"Scan the repository for TODO, FIXME, and XXX comments using ripgrep. " +
			"Returns a markdown checklist grouped by file. Use when the user asks about " +
			"outstanding tasks, incomplete work, known bugs, or tech debt markers." +
			"Optionally filter by tag (TODO, FIXME, XXX) or path pattern (e.g., 'src/', '*.ts').",
		promptSnippet: "Scan the repo for TODO/FIXME/XXX comments as a checklist",
		promptGuidelines: [
			"Use scan_todos when the user asks about outstanding TODOs, incomplete work, bugs, or tech debt.",
			"Use scan_todos with path filters to focus on specific directories or file types.",
		],
		parameters: Type.Object({
			tag: Type.Optional(
				Type.String({
					description: "Optional: filter by tag (TODO, FIXME, XXX). If omitted, shows all three.",
				}),
			),
			path: Type.Optional(
				Type.String({
					description:
						"Optional: glob path filter to scope the scan (e.g., 'src/', '*.ts', 'lib/**'). Defaults to whole repo.",
				}),
			),
			format: Type.Optional(
				Type.String({
					description: "Output format: 'checklist' (default) for markdown checklist, or 'summary' for a brief count.",
					default: "checklist",
				}),
			),
		}),

		async execute(
			_toolCallId,
			params: { tag?: string; path?: string; format?: string },
			_signal,
			_onUpdate,
			ctx,
		) {
			const cwd = ctx.cwd;
			const result = scanRepo(cwd);

			if (result.error) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					details: { error: result.error },
				};
			}

			let items = result.items;

			// Filter by tag if specified
			if (params.tag) {
				const tag = params.tag.toUpperCase();
				if (tag === "TODO" || tag === "FIXME" || tag === "XXX") {
					items = items.filter((i) => i.tag === tag);
				}
			}

			// Filter by path if specified
			if (params.path) {
				const pathFilter = params.path.replace(/\\/g, "/");
				items = items.filter((i) => i.file.replace(/\\/g, "/").includes(pathFilter) || i.file.match(new RegExp(pathFilter)));
			}

			const isSummary = params.format === "summary";

			return {
				content: [
					{
						type: "text",
						text: isSummary ? formatSummary(items) : formatChecklist(items),
					},
				],
				details: {
					total: items.length,
					files: new Set(items.map((i) => i.file)).size,
					breakdown: {
						TODO: items.filter((i) => i.tag === "TODO").length,
						FIXME: items.filter((i) => i.tag === "FIXME").length,
						XXX: items.filter((i) => i.tag === "XXX").length,
					},
					items,
				},
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("scan_todos ")) + theme.fg("muted", "scanning repo");
			if (args.tag) text += ` ${theme.fg("accent", `--tag ${args.tag}`)}`;
			if (args.path) text += ` ${theme.fg("dim", `--path ${args.path}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as any;
			if (!details || details.error) {
				return new Text(theme.fg("error", details?.error ?? "Error scanning"), 0, 0);
			}

			if (details.total === 0) {
				return new Text(theme.fg("success", "✅ No TODOs found"), 0, 0);
			}

			const summary = [
				theme.fg("accent", `${details.total}`) + " items, " + theme.fg("accent", `${details.files}`) + " files",
				theme.fg("accent", `  🔵 TODO: ${details.breakdown.TODO}`),
				theme.fg("error", `  🔴 FIXME: ${details.breakdown.FIXME}`),
				theme.fg("warning", `  🟡 XXX: ${details.breakdown.XXX}`),
			].join("\n");

			if (!expanded) {
				return new Text(summary, 0, 0);
			}

			// Expanded view shows items
			const items = details.items as TodoItem[];
			const lines: string[] = [summary, ""];

			const tagColors: Record<string, string> = {
				TODO: "accent",
				FIXME: "error",
				XXX: "warning",
			};

			// Group by file
			const grouped = new Map<string, TodoItem[]>();
			for (const item of items) {
				const existing = grouped.get(item.file) ?? [];
				existing.push(item);
				grouped.set(item.file, existing);
			}

			const sortedFiles = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
			for (const [file, fileItems] of sortedFiles) {
				fileItems.sort((a, b) => a.line - b.line);
				lines.push(theme.fg("dim", ` ${file}:`));
				for (const item of fileItems) {
					const color = tagColors[item.tag] ?? "muted";
					const icon = item.tag === "TODO" ? "○" : item.tag === "FIXME" ? "!" : "?";
					const tagStr = theme.fg(color as any, theme.bold(icon));
					lines.push(`   ${tagStr} L${item.line}: ${theme.fg("muted", item.text)}`);
				}
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ---- Command: /scan-todos (for user use) ----

	pi.registerCommand("scan-todos", {
		description: "Scan the repository for TODO, FIXME, and XXX comments",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const result = scanRepo(cwd);

			if (result.error) {
				ctx.ui.notify(`Error: ${result.error}`, "error");
				return;
			}

			if (!ctx.hasUI) {
				// Non-TUI mode: just print to output
				const text = formatChecklist(result.items);
				// Use notify as a fallback
				ctx.ui.notify(
					`Found ${result.items.length} items (TODO: ${result.items.filter((i) => i.tag === "TODO").length}, FIXME: ${result.items.filter((i) => i.tag === "FIXME").length}, XXX: ${result.items.filter((i) => i.tag === "XXX").length})`,
					"info",
				);
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new ScanResultsComponent(result.items, theme, () => done());
			});
		},
	});
}
