/**
 * File history for Pi
 *
 * Shows files changed through Pi's built-in write/edit tools and provides
 * /undo and /redo for those tracked mutations. Bash commands are deliberately
 * not guessed at: arbitrary shell commands cannot be reversed reliably.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";

type Snapshot = { exists: boolean; content?: string };
type Change = { path: string; before: Snapshot; after: Snapshot };

async function snapshot(path: string): Promise<Snapshot> {
	try {
		return { exists: true, content: (await readFile(path)).toString("base64") };
	} catch (error: any) {
		if (error?.code === "ENOENT") return { exists: false };
		throw error;
	}
}

async function restore(path: string, state: Snapshot): Promise<void> {
	if (!state.exists) {
		await rm(path, { force: true });
		return;
	}
	await mkdir(resolve(path, ".."), { recursive: true });
	await writeFile(path, Buffer.from(state.content!, "base64"));
}

export default function fileHistory(pi: ExtensionAPI) {
	const pending = new Map<string, { path: string; before: Snapshot }>();
	const undo: Change[] = [];
	const redo: Change[] = [];
	let applying = false;

	function displayPath(path: string, cwd: string): string {
		const value = relative(cwd, path);
		return value && !value.startsWith("..") ? value : path;
	}

	function updateWidget(ctx: any) {
		if (!ctx.hasUI) return;
		const latest = [...undo].reverse();
		const paths = [...new Set(latest.map((change) => displayPath(change.path, ctx.cwd)))];
		if (paths.length === 0) {
			ctx.ui.setWidget("file-history", undefined);
			ctx.ui.setStatus("file-history", undefined);
			return;
		}
		const visible = paths.slice(0, 8);
		const more = paths.length > visible.length ? ` +${paths.length - visible.length} more` : "";
		ctx.ui.setWidget("file-history", (_tui: unknown, theme: any) => ({
			render: (width: number) => [truncateToWidth(theme.fg("dim", `Modified: ${visible.join(", ")}${more}  ·  /undo  /redo`), width)],
			invalidate() {},
		}));
		ctx.ui.setStatus("file-history", ctx.ui.theme.fg("dim", `↶ ${undo.length}  ↷ ${redo.length}`));
	}

	pi.on("session_start", (_event, ctx) => updateWidget(ctx));

	pi.on("tool_call", async (event, ctx) => {
		if (applying || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string") return;
		const path = resolve(ctx.cwd, input.path.replace(/^@/, ""));
		try {
			pending.set(event.toolCallId, { path, before: await snapshot(path) });
		} catch (error: any) {
			ctx.ui.notify(`File history could not snapshot ${input.path}: ${error.message}`, "warning");
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const tracked = pending.get(event.toolCallId);
		if (!tracked) return;
		pending.delete(event.toolCallId);
		if (event.isError || applying) return;
		try {
			const after = await snapshot(tracked.path);
			if (tracked.before.exists !== after.exists || tracked.before.content !== after.content) {
				undo.push({ ...tracked, after });
				redo.length = 0;
				updateWidget(ctx);
			}
		} catch (error: any) {
			ctx.ui.notify(`File history could not record ${displayPath(tracked.path, ctx.cwd)}: ${error.message}`, "warning");
		}
	});

	pi.registerCommand("undo", {
		description: "Undo the latest file change tracked from write or edit",
		handler: async (_args, ctx) => {
			const change = undo.pop();
			if (!change) return ctx.ui.notify("Nothing to undo", "info");
			applying = true;
			try {
				await restore(change.path, change.before);
				redo.push(change);
				ctx.ui.notify(`Undid ${displayPath(change.path, ctx.cwd)}`, "info");
			} catch (error: any) {
				undo.push(change);
				ctx.ui.notify(`Undo failed: ${error.message}`, "error");
			} finally {
				applying = false;
				updateWidget(ctx);
			}
		},
	});

	pi.registerCommand("redo", {
		description: "Redo the latest file change undone with /undo",
		handler: async (_args, ctx) => {
			const change = redo.pop();
			if (!change) return ctx.ui.notify("Nothing to redo", "info");
			applying = true;
			try {
				await restore(change.path, change.after);
				undo.push(change);
				ctx.ui.notify(`Redid ${displayPath(change.path, ctx.cwd)}`, "info");
			} catch (error: any) {
				redo.push(change);
				ctx.ui.notify(`Redo failed: ${error.message}`, "error");
			} finally {
				applying = false;
				updateWidget(ctx);
			}
		},
	});
}
