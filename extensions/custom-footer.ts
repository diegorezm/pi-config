/**
 * Custom Footer Extension - demonstrates ctx.ui.setFooter()
 *
 * footerData exposes data not otherwise accessible:
 * - getGitBranch(): current git branch
 * - getExtensionStatuses(): texts from ctx.ui.setStatus()
 *
 * Token stats come from ctx.sessionManager/ctx.model (already accessible).
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function toTilde(fullPath: string, home: string = process.env.HOME ?? ""): string {
    if (home && (fullPath === home || fullPath.startsWith(home + "/"))) {
        return "~" + fullPath.slice(home.length);
    }
    return fullPath;
}

type FooterCtx = {
    ui: ExtensionContext["ui"];
    sessionManager: ExtensionContext["sessionManager"];
    model: ExtensionContext["model"];
};

function enableFooter(ctx: FooterCtx) {
    ctx.ui.setFooter((tui, theme, footerData) => {
        const unsub = footerData.onBranchChange(() => tui.requestRender());
        return {
            dispose: unsub,
            invalidate() { },
            render(width: number): string[] {
                const cwd = toTilde(ctx.sessionManager.getCwd())
                let input = 0,
                    output = 0,
                    cost = 0;
                for (const e of ctx.sessionManager.getBranch()) {
                    if (e.type === "message" && e.message.role === "assistant") {
                        const m = e.message as AssistantMessage;
                        input += m.usage.input;
                        output += m.usage.output;
                        cost += m.usage.cost.total;
                    }
                }
                const branch = footerData.getGitBranch();
                const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

                // color thresholds for cost — tune to taste
                const costColor =
                    cost < 0.10 ? "success" :
                        cost < 0.50 ? "warning" :
                            "error";

                const cwdPart = theme.fg("dim", `${cwd}: `);
                const tokensPart = theme.fg("muted", `↑${fmt(input)} ↓${fmt(output)} `);
                const costPart = theme.fg(costColor, `$${cost.toFixed(3)}`);
                const left = cwdPart + tokensPart + costPart;

                const modelPart = theme.fg("dim", `${ctx.model?.id || "no-model"}`);
                const branchPart = branch ? theme.fg("accent", ` (${branch})`) : "";
                const right = modelPart + branchPart;

                const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
                return [truncateToWidth(left + pad + right, width)];
            },
        };
    });
}

export default function(pi: ExtensionAPI) {
    let enabled = false;

    pi.registerCommand("footer", {
        description: "Toggle custom footer",
        handler: async (_args, ctx) => {
            enabled = !enabled;
            if (enabled) {
                enableFooter(ctx);
                ctx.ui.notify("Custom footer enabled", "info");
            } else {
                ctx.ui.setFooter(undefined);
                ctx.ui.notify("Default footer restored", "info");
            }
        },
    });

    pi.on("session_start", (_evnt, ctx) => {
        if (!enabled) {
            enabled = true;
            enableFooter(ctx);
        }
    })
}
