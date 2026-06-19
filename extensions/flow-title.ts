import path from "node:path";

import type {
    ExtensionAPI,
    ExtensionContext,
    Theme,
    ThemeColor,
} from "@earendil-works/pi-coding-agent";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

type Rgb = [number, number, number];
const _DEFAULT_TITLE = [
    "  ██████╗  ██╗ ",
    "  ██╔══██╗ ██║ ",
    "  ██████╔╝ ██║ ",
    "  ██╔═══╝  ██║ ",
    "  ██║      ██║ ",
    "  ╚═╝      ╚═╝ ",
]

const TITLE_LINES = [
    "███▀▀▀▀▀▀████▀▀████",
    "███░▄░▄░╖░▐████▄░▐█",
    "█░▄░░░┬░║▒▐████▀░▐█",
    "█▄┴───┘░╙─┘▒▒▒▒░▄██",
    "████▌░░░░░░░░░░░███",
    "█████▒██░███▒██░███",
    "████▄▄█▄▄██▄▄█▄▄███",
];
/* -----------------------------
   Theme utilities
------------------------------*/

function ansiToRgb(ansi: string): Rgb | null {
    // expects: \x1b[38;2;r;g;bm
    const match = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
    if (!match) return null;

    return [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
    ];
}

function getThemePalette(theme: Theme): Rgb[] {
    const colors: ThemeColor[] = [
        "accent",
        "text",
        "muted",
        "dim",
        "warning",
    ];

    const palette = colors
        .map((c) => ansiToRgb(theme.getFgAnsi(c)))
        .filter(Boolean) as Rgb[];

    // fallback safety
    if (palette.length < 2) {
        return [
            [80, 140, 255],
            [120, 180, 255],
            [80, 140, 255],
        ];
    }

    return palette;
}

/* -----------------------------
   Gradient math
------------------------------*/

function mix(a: number, b: number, t: number) {
    return Math.round(a + (b - a) * t);
}

function sampleGradient(position: number, palette: Rgb[]) {
    const wrapped = ((position % 1) + 1) % 1;
    const scaled = wrapped * palette.length;

    const index = Math.floor(scaled);
    const nextIndex = (index + 1) % palette.length;

    const t = scaled - index;

    const a = palette[index]!;
    const b = palette[nextIndex]!;

    return [
        mix(a[0], b[0], t),
        mix(a[1], b[1], t),
        mix(a[2], b[2], t),
    ] as Rgb;
}

function fg([r, g, b]: Rgb, text: string) {
    return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

/* -----------------------------
   Text helpers
------------------------------*/

function gradientText(text: string, phase: number, palette: Rgb[]) {
    const chars = [...text];
    const span = Math.max(chars.length - 1, 1);

    return chars
        .map((char, index) => {
            if (char === " ") return char;

            return fg(
                sampleGradient(index / span + phase, palette),
                char,
            );
        })
        .join("");
}

function center(text: string, width: number) {
    const length = [...text].length;
    if (length >= width) return text;

    return `${" ".repeat(Math.floor((width - length) / 2))}${text}`;
}

function projectName() {
    return path.basename(process.cwd()) || "session";
}

/* -----------------------------
   Theme-aware header renderer
------------------------------*/

function renderHeader(
    theme: Theme,
    width: number,
    phase: number,
    subtitleText: string,
) {
    const palette = getThemePalette(theme);

    const lines = TITLE_LINES.map((line, row) =>
        gradientText(
            center(line, width),
            phase + row * 0.045,
            palette,
        ),
    );

    const subtitle = center(subtitleText, width);

    return [
        "",
        ...lines,
        `${BOLD}${gradientText(subtitle, phase + 0.18, palette)}${RESET}`,
        "",
    ];
}

/* -----------------------------
   Extension
------------------------------*/

export default function(pi: ExtensionAPI) {
    let requestRender: (() => void) | undefined;
    let currentModelId = "no model selected";

    function installHeader(ctx: ExtensionContext) {
        ctx.ui.setHeader((tui) => {
            requestRender = () => tui.requestRender();

            return {
                render(width: number) {
                    return renderHeader(
                        ctx.ui.theme,
                        width,
                        0,
                        `${currentModelId} · ${projectName()}`,
                    );
                },

                invalidate() {
                    tui.requestRender();
                },
            };
        });
    }

    pi.on("session_start", (_event, ctx) => {
        currentModelId = ctx.model?.id ?? "no model selected";

        if (!ctx.hasUI) return;

        installHeader(ctx);
    });

    pi.on("model_select", (event) => {
        currentModelId = event.model.id;
        requestRender?.();
    });

    pi.on("session_shutdown", (_event, ctx) => {
        if (ctx.hasUI) ctx.ui.setHeader(undefined);
    });

    pi.registerCommand("flow-title", {
        description: "Enable the theme-aware gradient session header",
        handler: async (_args, ctx) => {
            installHeader(ctx);
            ctx.ui.notify("Flow title enabled", "info");
        },
    });

    pi.registerCommand("flow-title-builtin", {
        description: "Restore pi's built-in header for this session",
        handler: async (_args, ctx) => {
            ctx.ui.setHeader(undefined);
            ctx.ui.notify("Built-in header restored", "info");
        },
    });
}
