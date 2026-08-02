/**
 * Optional, agent-managed task tracking.
 *
 * The agent alone changes the list through the `todo` tool. The user gets a
 * persistent read-only summary and can open the complete list with
 * Ctrl+Alt+T or /todos.
 */

import { StringEnum, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed";

interface Todo {
    id: number;
    text: string;
    status: TodoStatus;
}

interface TodoState {
    action: TodoAction;
    todos: Todo[];
    nextId: number;
    error?: string;
}

const Status = StringEnum(["pending", "in_progress", "completed"] as const);
const Action = StringEnum(["list", "add", "update", "replace", "clear"] as const);
type TodoAction = Static<typeof Action>;

const TodoItem = Type.Object({
    id: Type.Optional(Type.Integer({ minimum: 1, description: "Existing task ID to preserve when replacing a list" })),
    text: Type.String({ minLength: 1, description: "Concise task description" }),
    status: Type.Optional(Status),
});

const TodoParams = Type.Object({
    action: Action,
    text: Type.Optional(Type.String({ minLength: 1, description: "Task description, required for add" })),
    id: Type.Optional(Type.Integer({ minimum: 1, description: "Task ID, required for update" })),
    status: Type.Optional(Status),
    items: Type.Optional(Type.Array(TodoItem, { description: "Replacement list in its desired order, required for replace" })),
});

type TodoParams = Static<typeof TodoParams>;

function isTodoStatus(value: unknown): value is TodoStatus {
    return value === "pending" || value === "in_progress" || value === "completed";
}

function cloneTodos(todos: Todo[]): Todo[] {
    return todos.map((todo) => ({ ...todo }));
}

function textForAgent(todos: Todo[]): string {
    if (todos.length === 0) return "No tasks are currently tracked.";
    return todos
        .map((todo) => `[${todo.status}] #${todo.id} ${todo.text}`)
        .join("\n");
}

class TodoOverlay {
    private readonly todos: Todo[];
    private readonly theme: Theme;
    private readonly close: () => void;
    private offset = 0;
    private cachedWidth?: number;
    private cachedLines?: string[];

    constructor(todos: Todo[], theme: Theme, close: () => void) {
        this.todos = cloneTodos(todos);
        this.theme = theme;
        this.close = close;
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            this.close();
            return;
        }
        const pageSize = 14;
        if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
        else if (matchesKey(data, Key.down)) this.offset = Math.min(Math.max(0, this.todos.length - pageSize), this.offset + 1);
        else if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - pageSize);
        else if (matchesKey(data, Key.pageDown)) this.offset = Math.min(Math.max(0, this.todos.length - pageSize), this.offset + pageSize);
        else return;
        this.invalidate();
    }

    render(width: number): string[] {
        if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
        const safeWidth = Math.max(1, width);
        const complete = this.todos.filter((todo) => todo.status === "completed").length;
        const lines = [
            truncateToWidth(this.theme.fg("accent", this.theme.bold(" Tasks")), safeWidth),
            truncateToWidth(this.theme.fg("muted", ` ${complete}/${this.todos.length} complete`), safeWidth),
            "",
        ];

        if (this.todos.length === 0) {
            lines.push(truncateToWidth(this.theme.fg("dim", " No tasks are currently tracked."), safeWidth));
        } else {
            const visible = this.todos.slice(this.offset, this.offset + 14);
            for (const todo of visible) {
                const marker = todo.status === "completed" ? this.theme.fg("success", "✓") : todo.status === "in_progress" ? this.theme.fg("accent", "●") : this.theme.fg("dim", "○");
                const label = todo.status === "completed"
                    ? this.theme.fg("muted", this.theme.strikethrough(todo.text))
                    : this.theme.fg("text", todo.text);
                lines.push(truncateToWidth(` ${marker} ${this.theme.fg("dim", `#${todo.id}`)} ${label}`, safeWidth));
            }
            if (this.todos.length > 14) {
                lines.push("");
                lines.push(truncateToWidth(this.theme.fg("dim", ` ${this.offset + 1}-${Math.min(this.offset + 14, this.todos.length)} of ${this.todos.length}`), safeWidth));
            }
        }

        lines.push("");
        lines.push(truncateToWidth(this.theme.fg("dim", " ↑↓ scroll • Esc close"), safeWidth));
        this.cachedWidth = width;
        this.cachedLines = lines;
        return lines;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }
}

export default function agentTodos(pi: ExtensionAPI): void {
    let todos: Todo[] = [];
    let nextId = 1;

    function restore(ctx: ExtensionContext): void {
        todos = [];
        nextId = 1;
        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") continue;
            const state = entry.message.details as TodoState | undefined;
            if (!state || !Array.isArray(state.todos) || !Number.isInteger(state.nextId)) continue;
            todos = state.todos
                .filter((todo): todo is Todo => typeof todo?.id === "number" && typeof todo.text === "string" && isTodoStatus(todo.status))
                .map((todo) => ({ ...todo }));
            nextId = state.nextId;
        }
    }

    function updateUi(ctx: ExtensionContext): void {
        if (ctx.mode !== "tui") return;
        if (todos.length === 0) {
            ctx.ui.setWidget("agent-todos", undefined);
            return;
        }

        ctx.ui.setWidget("agent-todos", (_tui, theme) => ({
            render(width: number): string[] {
                const complete = todos.filter((todo) => todo.status === "completed").length;
                const active = todos.find((todo) => todo.status === "in_progress");
                const remaining = todos.filter((todo) => todo.status !== "completed").slice(0, 4);
                const lines = [
                    theme.fg("accent", theme.bold(` Tasks  ${complete}/${todos.length} complete`)),
                    ...(active ? [theme.fg("muted", " Active: ") + theme.fg("text", active.text)] : []),
                    ...remaining.map((todo) => {
                        const marker = todo.status === "in_progress" ? theme.fg("accent", "●") : theme.fg("dim", "○");
                        return ` ${marker} ${theme.fg("text", todo.text)}`;
                    }),
                    ...(todos.filter((todo) => todo.status !== "completed").length > remaining.length
                        ? [theme.fg("dim", ` … ${todos.filter((todo) => todo.status !== "completed").length - remaining.length} more`)]
                        : []),
                    theme.fg("dim", " Ctrl+Alt+T: view all"),
                ];
                return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
            },
            invalidate(): void {},
        }));
    }

    function result(action: TodoAction, error?: string) {
        return {
            content: [{ type: "text" as const, text: error ?? textForAgent(todos) }],
            details: { action, todos: cloneTodos(todos), nextId, ...(error ? { error } : {}) } satisfies TodoState,
        };
    }

    async function showTodos(ctx: ExtensionContext): Promise<void> {
        if (ctx.mode !== "tui") {
            ctx.ui.notify("The todo view is only available in the interactive TUI.", "info");
            return;
        }
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
            const overlay = new TodoOverlay(todos, theme, done);
            return {
                render: (width) => overlay.render(width),
                handleInput: (data) => {
                    overlay.handleInput(data);
                    tui.requestRender();
                },
                invalidate: () => overlay.invalidate(),
            };
        }, { overlay: true, overlayOptions: { anchor: "right-center", width: "45%", minWidth: 36, maxHeight: "80%", margin: 2 } });
    }

    pi.on("session_start", (_event, ctx) => {
        restore(ctx);
        updateUi(ctx);
    });
    pi.on("session_tree", (_event, ctx) => {
        restore(ctx);
        updateUi(ctx);
    });

    pi.registerTool({
        name: "todo",
        label: "Todo",
        description: "Optionally manage a private, session-persistent task list. Actions: list, add, update, replace, clear. The user can view it but cannot edit it.",
        promptSnippet: "Optionally track a multi-step task in a private, user-visible todo list.",
        promptGuidelines: [
            "Use todo only when a task list would help manage substantial multi-step work; it is optional for simple tasks.",
            "Use todo replace to establish or reorder a plan, todo update to mark progress, and todo clear when the list is no longer useful.",
        ],
        parameters: TodoParams,
        executionMode: "sequential",
        renderShell: "self",
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            switch (params.action) {
                case "list":
                    return result("list");
                case "add": {
                    if (!params.text?.trim()) return result("add", "text is required for add");
                    todos.push({ id: nextId++, text: params.text.trim(), status: params.status ?? "pending" });
                    updateUi(ctx);
                    return result("add");
                }
                case "update": {
                    if (params.id === undefined) return result("update", "id is required for update");
                    const todo = todos.find((item) => item.id === params.id);
                    if (!todo) return result("update", `Task #${params.id} was not found.`);
                    if (params.text !== undefined) {
                        if (!params.text.trim()) return result("update", "text cannot be empty");
                        todo.text = params.text.trim();
                    }
                    if (params.status !== undefined) todo.status = params.status;
                    updateUi(ctx);
                    return result("update");
                }
                case "replace": {
                    if (!params.items) return result("replace", "items is required for replace");
                    if (params.items.some((item) => !item.text.trim())) return result("replace", "task text cannot be empty");
                    const usedIds = new Set<number>();
                    const replacement: Todo[] = [];
                    for (const item of params.items) {
                        const id = item.id !== undefined && !usedIds.has(item.id) ? item.id : nextId++;
                        usedIds.add(id);
                        nextId = Math.max(nextId, id + 1);
                        replacement.push({ id, text: item.text.trim(), status: item.status ?? "pending" });
                    }
                    todos = replacement;
                    updateUi(ctx);
                    return result("replace");
                }
                case "clear":
                    todos = [];
                    nextId = 1;
                    updateUi(ctx);
                    return result("clear");
            }
        },
        renderCall: () => ({ render: () => [], invalidate: () => {} }),
        renderResult: () => ({ render: () => [], invalidate: () => {} }),
    });

    pi.registerCommand("todos", {
        description: "Open the read-only agent todo list",
        handler: async (_args, ctx) => showTodos(ctx),
    });
    pi.registerShortcut(Key.ctrlAlt("t"), {
        description: "Open the read-only agent todo list",
        handler: async (ctx) => showTodos(ctx),
    });
}
