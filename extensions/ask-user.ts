/**
 * ask_user - Lets the model ask one interactive question.
 *
 * Supported kinds: multiple_choice (default), yes_no, true_false,
 * free_text, rating, and multi_select.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, type Static, Type } from "@earendil-works/pi-ai";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MIN_RATING = 0;
const MAX_RATING = 10;

const KindSchema = StringEnum(
    ["multiple_choice", "yes_no", "true_false", "free_text", "rating", "multi_select"] as const,
    { description: "Question interaction type; defaults to multiple_choice." },
);

const OptionSchema = Type.Object({
    label: Type.String({ description: "Short display label for this option" }),
    description: Type.Optional(Type.String({ description: "Optional one-line description shown below the label" })),
});

const AskUserParams = Type.Object({
    question: Type.String({ description: "The single question to ask the user" }),
    kind: Type.Optional(KindSchema),
    options: Type.Optional(
        Type.Array(OptionSchema, {
            minItems: MIN_OPTIONS,
            maxItems: MAX_OPTIONS,
            description: "Required for multiple_choice and multi_select; never include a custom-answer option.",
        }),
    ),
    allowOther: Type.Optional(
        Type.Boolean({ description: "For multiple_choice only: append a free-form answer option (defaults to true)." }),
    ),
    minSelections: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_OPTIONS, description: "For multi_select: minimum selections (defaults to 1)." }),
    ),
    maxSelections: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_OPTIONS, description: "For multi_select: maximum selections (defaults to all options)." }),
    ),
    min: Type.Optional(Type.Integer({ minimum: MIN_RATING, maximum: MAX_RATING, description: "For rating: lowest value (defaults to 1)." })),
    max: Type.Optional(Type.Integer({ minimum: MIN_RATING, maximum: MAX_RATING, description: "For rating: highest value (defaults to 5)." })),
    lowLabel: Type.Optional(Type.String({ description: "For rating: optional label for the low end." })),
    highLabel: Type.Optional(Type.String({ description: "For rating: optional label for the high end." })),
});

type AskUserKind = Static<typeof KindSchema>;
export type AskUserInput = Static<typeof AskUserParams>;

interface DisplayOption {
    label: string;
    description?: string;
    isOther?: boolean;
}

interface ValidatedParams {
    kind: AskUserKind;
    options: DisplayOption[];
    allowOther: boolean;
    minSelections?: number;
    maxSelections?: number;
    min?: number;
    max?: number;
    lowLabel?: string;
    highLabel?: string;
}

interface AskUserDetails {
    question: string;
    kind: AskUserKind;
    options: string[];
    answer: string | null;
    answers?: string[];
    wasCustom: boolean;
    cancelled: boolean;
}

type SelectionResult = { answers: string[]; wasCustom: boolean; index?: number } | null;

function wrapText(text: string, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
        const words = paragraph.split(/\s+/).filter(Boolean);
        if (words.length === 0) {
            lines.push("");
            continue;
        }
        let current = "";
        for (const word of words) {
            const candidate = current ? `${current} ${word}` : word;
            if (candidate.length > width && current) {
                lines.push(current);
                current = word;
            } else {
                current = candidate;
            }
        }
        if (current) lines.push(current);
    }
    return lines;
}

function normalizeKind(kind: unknown): AskUserKind {
    switch (kind) {
        case "yes_no":
        case "true_false":
        case "free_text":
        case "rating":
        case "multi_select":
            return kind;
        default:
            return "multiple_choice";
    }
}

function validateParams(params: AskUserInput): ValidatedParams {
    const kind = normalizeKind(params.kind);
    const options = params.options ?? [];
    const hasRatingFields = params.min !== undefined || params.max !== undefined || params.lowLabel !== undefined || params.highLabel !== undefined;
    const hasSelectionFields = params.minSelections !== undefined || params.maxSelections !== undefined;

    if (kind === "multiple_choice" || kind === "multi_select") {
        if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
            throw new Error(`ask_user kind '${kind}' requires ${MIN_OPTIONS}-${MAX_OPTIONS} options.`);
        }
    } else if (options.length > 0) {
        throw new Error(`ask_user kind '${kind}' does not accept options.`);
    }

    if (kind !== "multiple_choice" && params.allowOther !== undefined) {
        throw new Error(`ask_user kind '${kind}' does not support allowOther.`);
    }
    if (kind !== "multi_select" && hasSelectionFields) {
        throw new Error(`ask_user kind '${kind}' does not support minSelections or maxSelections.`);
    }
    if (kind !== "rating" && hasRatingFields) {
        throw new Error(`ask_user kind '${kind}' does not support rating fields.`);
    }

    if (kind === "multi_select") {
        const minSelections = params.minSelections ?? 1;
        const maxSelections = params.maxSelections ?? options.length;
        if (minSelections > maxSelections || maxSelections > options.length) {
            throw new Error("ask_user multi_select requires 1 <= minSelections <= maxSelections <= options.length.");
        }
        return { kind, options, allowOther: false, minSelections, maxSelections };
    }

    if (kind === "rating") {
        const min = params.min ?? 1;
        const max = params.max ?? 5;
        if (min > max) throw new Error("ask_user rating requires min to be less than or equal to max.");
        return { kind, options: [], allowOther: false, min, max, lowLabel: params.lowLabel, highLabel: params.highLabel };
    }

    return { kind, options, allowOther: params.allowOther ?? kind === "multiple_choice" };
}

export default function askUser(pi: ExtensionAPI) {
    pi.registerTool({
        name: "ask_user",
        label: "Ask User",
        description:
            "Ask the user exactly one interactive question. Kinds: multiple_choice (default), yes_no, true_false, free_text, rating, and multi_select.",
        promptSnippet: "Ask exactly one interactive question; select the appropriate ask_user kind.",
        promptGuidelines: [
            "Use ask_user for a single question requiring interactive input instead of asking it in plain text.",
            "Use ask_user kind yes_no, true_false, free_text, rating, or multi_select when appropriate; otherwise use multiple_choice.",
            "Ask exactly one question per ask_user call and ask follow-ups in later calls.",
        ],
        parameters: AskUserParams,

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const validated = validateParams(params);
            const fixedOptions: DisplayOption[] =
                validated.kind === "yes_no"
                    ? [{ label: "Yes" }, { label: "No" }]
                    : validated.kind === "true_false"
                      ? [{ label: "True" }, { label: "False" }]
                      : validated.kind === "rating"
                        ? Array.from({ length: (validated.max ?? 5) - (validated.min ?? 1) + 1 }, (_, index) => ({ label: String((validated.min ?? 1) + index) }))
                        : validated.options;
            const displayOptions =
                validated.kind === "multiple_choice" && validated.allowOther
                    ? [...fixedOptions, { label: "Write my own answer…", isOther: true }]
                    : fixedOptions;
            const baseDetails = {
                question: params.question,
                kind: validated.kind,
                options: fixedOptions.map((option) => option.label),
            } satisfies Omit<AskUserDetails, "answer" | "answers" | "wasCustom" | "cancelled">;

            if (ctx.mode !== "tui") {
                return {
                    content: [{ type: "text", text: "No interactive UI is available, so the question could not be shown. Ask the user in plain text instead." }],
                    details: { ...baseDetails, answer: null, wasCustom: false, cancelled: true } satisfies AskUserDetails,
                };
            }
            if (signal?.aborted) {
                return {
                    content: [{ type: "text", text: "Cancelled" }],
                    details: { ...baseDetails, answer: null, wasCustom: false, cancelled: true } satisfies AskUserDetails,
                };
            }

            const result = await ctx.ui.custom<SelectionResult>((tui, theme, _kb, done) => {
                let optionIndex = 0;
                let editMode = validated.kind === "free_text";
                let cachedLines: string[] | undefined;
                let validationMessage: string | undefined;
                const selectedIndexes = new Set<number>();
                const themeForEditor: EditorTheme = {
                    borderColor: (text) => theme.fg("accent", text),
                    selectList: {
                        selectedPrefix: (text) => theme.fg("accent", text),
                        selectedText: (text) => theme.fg("accent", text),
                        description: (text) => theme.fg("muted", text),
                        scrollInfo: (text) => theme.fg("dim", text),
                        noMatch: (text) => theme.fg("warning", text),
                    },
                };
                const editor = new Editor(tui, themeForEditor);

                editor.onSubmit = (value) => {
                    const answer = value.trim();
                    if (answer) done({ answers: [answer], wasCustom: true });
                    else {
                        validationMessage = "Please enter an answer.";
                        refresh();
                    }
                };

                function refresh() {
                    cachedLines = undefined;
                    tui.requestRender();
                }

                function selectOption(index: number) {
                    const option = displayOptions[index];
                    if (!option) return;
                    if (option.isOther) {
                        optionIndex = index;
                        editMode = true;
                        validationMessage = undefined;
                        refresh();
                        return;
                    }
                    done({ answers: [option.label], wasCustom: false, index: index + 1 });
                }

                function toggleSelection(index: number) {
                    if (selectedIndexes.has(index)) {
                        selectedIndexes.delete(index);
                        validationMessage = undefined;
                    } else if (selectedIndexes.size >= (validated.maxSelections ?? fixedOptions.length)) {
                        validationMessage = `Select at most ${validated.maxSelections} option${validated.maxSelections === 1 ? "" : "s"}.`;
                    } else {
                        selectedIndexes.add(index);
                        validationMessage = undefined;
                    }
                    refresh();
                }

                function handleInput(data: string) {
                    if (editMode) {
                        if (matchesKey(data, Key.escape)) {
                            if (validated.kind === "free_text") done(null);
                            else {
                                editMode = false;
                                editor.setText("");
                                validationMessage = undefined;
                                refresh();
                            }
                            return;
                        }
                        editor.handleInput(data);
                        refresh();
                        return;
                    }

                    if (matchesKey(data, Key.up)) {
                        optionIndex = (optionIndex - 1 + displayOptions.length) % displayOptions.length;
                        refresh();
                        return;
                    }
                    if (matchesKey(data, Key.down)) {
                        optionIndex = (optionIndex + 1) % displayOptions.length;
                        refresh();
                        return;
                    }
                    if (validated.kind === "multi_select") {
                        if (matchesKey(data, Key.space)) {
                            toggleSelection(optionIndex);
                            return;
                        }
                        if (matchesKey(data, Key.enter)) {
                            const count = selectedIndexes.size;
                            const minSelections = validated.minSelections ?? 1;
                            if (count < minSelections) {
                                validationMessage = `Select at least ${minSelections} option${minSelections === 1 ? "" : "s"}.`;
                                refresh();
                            } else {
                                done({
                                    answers: [...selectedIndexes].sort((a, b) => a - b).flatMap((index) => fixedOptions[index] ? [fixedOptions[index].label] : []),
                                    wasCustom: false,
                                });
                            }
                            return;
                        }
                    } else {
                        if (data.length === 1 && /^[1-9]$/.test(data) && Number(data) <= displayOptions.length) {
                            selectOption(Number(data) - 1);
                            return;
                        }
                        if (matchesKey(data, Key.enter)) {
                            selectOption(optionIndex);
                            return;
                        }
                    }
                    if (matchesKey(data, Key.escape)) done(null);
                }

                function render(width: number): string[] {
                    if (cachedLines) return cachedLines;
                    const renderWidth = Math.max(1, width);
                    const lines: string[] = [];
                    const add = (text: string) => lines.push(truncateToWidth(text, renderWidth));
                    add(theme.fg("accent", `─ Question ${"─".repeat(Math.max(0, renderWidth - 10))}`));
                    for (const line of wrapText(params.question, Math.max(1, renderWidth - 2))) {
                        add(` ${theme.fg("text", theme.bold(line))}`);
                    }
                    lines.push("");

                    if (editMode) {
                        add(theme.fg("muted", " Your answer:"));
                        for (const line of editor.render(Math.max(1, renderWidth - 2))) add(` ${line}`);
                    } else {
                        if (validated.kind === "rating" && (validated.lowLabel || validated.highLabel)) {
                            add(theme.fg("muted", ` ${validated.lowLabel ?? ""}${validated.lowLabel && validated.highLabel ? " — " : ""}${validated.highLabel ?? ""}`));
                        }
                        for (let index = 0; index < displayOptions.length; index++) {
                            const option = displayOptions[index];
                            if (!option) continue;
                            const focused = index === optionIndex;
                            const cursor = focused ? theme.fg("accent", " ❯ ") : "   ";
                            const marker = validated.kind === "multi_select" ? (selectedIndexes.has(index) ? "[x]" : "[ ]") : option.isOther ? "✎" : `${index + 1}.`;
                            const label = `${marker} ${option.label}`;
                            add(cursor + theme.fg(focused ? "accent" : option.isOther ? "muted" : "text", label));
                            if (option.description) add(`      ${theme.fg("muted", option.description)}`);
                        }
                    }

                    lines.push("");
                    if (validationMessage) add(theme.fg("warning", ` ${validationMessage}`));
                    if (editMode) add(theme.fg("dim", validated.kind === "free_text" ? " Enter submit • Esc dismiss" : " Enter submit • Esc back to options"));
                    else if (validated.kind === "multi_select") add(theme.fg("dim", " ↑↓ move • Space toggle • Enter submit • Esc dismiss"));
                    else add(theme.fg("dim", ` ↑↓ or 1-${displayOptions.length} select • Enter confirm • Esc dismiss`));
                    add(theme.fg("accent", "─".repeat(renderWidth)));
                    cachedLines = lines;
                    return lines;
                }

                return { render, handleInput, invalidate: () => { cachedLines = undefined; } };
            });

            if (!result) {
                return {
                    content: [{ type: "text", text: "User dismissed the question without answering. Do not assume an answer; proceed accordingly or ask differently." }],
                    details: { ...baseDetails, answer: null, wasCustom: false, cancelled: true } satisfies AskUserDetails,
                };
            }

            const answer = result.answers.join(", ");
            const details = {
                ...baseDetails,
                answer,
                ...(validated.kind === "multi_select" ? { answers: result.answers } : {}),
                wasCustom: result.wasCustom,
                cancelled: false,
            } satisfies AskUserDetails;
            const text = result.wasCustom
                ? `User wrote their own answer: ${answer}`
                : validated.kind === "multi_select"
                  ? `User selected: ${answer}`
                  : `User selected${result.index ? ` option ${result.index}` : ""}: ${answer}`;
            return { content: [{ type: "text", text }], details };
        },

        renderCall(args, theme, _context) {
            const question = typeof args.question === "string" ? args.question : "";
            const kind = typeof args.kind === "string" ? args.kind : "multiple_choice";
            let text = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", question);
            text += `\n${theme.fg("dim", `  kind: ${kind}`)}`;
            const options = Array.isArray(args.options) ? (args.options as DisplayOption[]) : [];
            if (options.length) text += `\n${theme.fg("dim", `  ${options.map((option, index) => `${index + 1}. ${option.label}`).join("  ")}`)}`;
            return new Text(text, 0, 0);
        },

        renderResult(result, _options, theme, _context) {
            const details = result.details as AskUserDetails | undefined;
            if (!details) {
                const first = result.content[0];
                return new Text(first?.type === "text" ? first.text : "", 0, 0);
            }
            if (details.cancelled || details.answer === null) return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
            const prefix = details.wasCustom ? theme.fg("muted", "(wrote) ") : "";
            return new Text(theme.fg("success", "✓ ") + prefix + theme.fg("accent", details.answer), 0, 0);
        },
    });
}
