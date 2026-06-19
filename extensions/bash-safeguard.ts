/**
 * Bash Safeguard Extension
 *
 * Intercepts all bash tool calls and checks commands against dangerous patterns.
 * Some patterns are blocked immediately without prompting (fork bomb, writes to
 * critical system paths). Most patterns prompt the user for confirmation.
 *
 * Pattern categories:
 *   1) Git Destruction / History Rewriting
 *   2) Filesystem Deletion / Overwrite
 *   3) Docker / Podman Destruction
 *   4) Package Removal
 *   5) System State / Permissions
 *   6) Fork bomb (immediately blocked)
 *   7) Secret File Access (cat, grep, rg, awk, sed, cp, etc.)
 *   8) Protected Paths (write tool prompts to .ssh/, .env, credentials, etc.)
 *   9) Critical system path writes (immediately blocked)
 *  10) SQL destructive operations
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function(pi: ExtensionAPI) {
    // ─────────────────────────────────────────────────────────────
    // 1) Git Destruction / History Rewriting
    // ────────────────────────────────────────────────────────────
    const gitPatterns: RegExp[] = [
        // git reset --hard / --soft / --mixed / --merge / --keep
        /\bgit\s+reset\s+--(?:hard|soft|mixed|merge|keep)\b/i,

        // git reset HEAD~... / HEAD^... / <commithash>
        /\bgit\s+reset\s+HEAD~[0-9]*\b/i,
        /\bgit\s+reset\s+HEAD\^/i,
        // git reset <hash>  (40-char hex, optionally with caret/tilde)
        /\bgit\s+reset\s+[0-9a-f]{7,40}(?:~[0-9]*|\^+)?\b/i,

        // git clean -f / -fd / -xdf
        /\bgit\s+clean\s+-(?:[a-z]*f[a-z]*(?:d[a-z]*)?|[a-z]*d[a-z]*(?:f[a-z]*)?|x[a-z]*d[a-z]*f[a-z]*)\b/i,

        // git checkout -- <path> (discard local changes)
        /\bgit\s+checkout\s+--\b/,
        // git switch ... (destructive branch switch)
        /\bgit\s+switch\s+/i,
        // git restore ...
        /\bgit\s+restore\s+/i,
        // git checkout <branch> (when force overrides)
        /\bgit\s+checkout\s+-[bB]\s+/i,

        // git branch -d / -D
        /\bgit\s+branch\s+-(?:d|D)\s+/i,
        // git tag -d
        /\bgit\s+tag\s+-d\s+/i,

        // git push --force / --force-with-lease / --delete / :refs/heads/...
        /\bgit\s+push\s+.*--force\b/i,
        /\bgit\s+push\s+-f(?![a-z])/i,
        /\bgit\s+push\s+.*--delete\b/i,
        /\bgit\s+push\s+.*:refs\/heads\//i,
        /\bgit\s+push\s+.*:[\w\/-]+\s*$/i,

        // git rebase (including interactive)
        /\bgit\s+rebase\s+/i,

        // git commit --amend / --fixup / --squash
        /\bgit\s+commit\s+.*--amend\b/i,
        /\bgit\s+commit\s+.*--fixup\b/i,
        /\bgit\s+commit\s+.*--squash\b/i,

        // git filter-branch / filter-repo
        /\bgit\s+filter-branch\b/i,
        /\bgit\s+filter-repo\b/i,

        // git replace / git update-ref
        /\bgit\s+replace\b/i,
        /\bgit\s+update-ref\b/i,

        // git notes remove / git notes prune
        /\bgit\s+notes\s+remove\b/i,
        /\bgit\s+notes\s+prune\b/i,

        // git reflog expire / git gc --prune / git prune
        /\bgit\s+reflog\s+expire\b/i,
        /\bgit\s+gc\s+.*--prune\b/i,
        /\bgit\s+prune\b/i,
    ];

    // ─────────────────────────────────────────────────────────────
    // 2) Filesystem Deletion / Overwrite
    // ────────────────────────────────────────────────────────────
    const fsDestructPatterns: RegExp[] = [
        // rm -rf targeting /, ~, $HOME, ., or globs
        /\brm\s+-(?:[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*)\s+(?:\/|~\/|\$HOME\/|\.(?:\s|$)|\*)/,
        // rm -rf with globs (e.g., rm -rf *)
        /\brm\s+-(?:[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*)\s+/,
        // rm -r (recursive delete)
        /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\b/,
        // rm -f (force delete file)
        /\brm\s+-[a-zA-Z]*[fF][a-zA-Z]*\b/,
        // find ... -delete
        /\bfind\s+.*\b-delete\b/,
        // find ... -exec rm ...
        /\bfind\s+.*\b-exec\s+.*\brm\b/,
        // xargs ... rm
        /\bxargs\s+.*\brm\b/,
        // truncate -s 0
        /\btruncate\s+-s\s+0\b/,
        // shred (secure file deletion)
        /\bshred\b/,
        // dd if= of= (disk write)
        /\bdd\s+(?:if\s*=|of\s*=)/,
        // mkfs, wipefs, parted, fdisk, sfdisk, sgdisk
        /\bmkfs\s+/,
        /\bwipefs\b/,
        /\bparted\s+/,
        /\bfdisk\s+/,
        /\bsfdisk\s+/,
        /\bsgdisk\s+/,
    ];

    // ─────────────────────────────────────────────────────────────
    // 3) Docker / Podman Destruction
    // ────────────────────────────────────────────────────────────
    const containerPatterns: RegExp[] = [
        // docker rm, docker rmi
        /\bdocker\s+(?:rm|rmi)\b/,
        // docker volume rm, docker volume prune
        /\bdocker\s+volume\s+(?:rm|prune)\b/,
        // docker system prune
        /\bdocker\s+system\s+prune\b/,
        // docker compose down -v / --volumes
        /\bdocker(?:\s+compose)?\s+down\s+.*-(?:v|-volumes)\b/,
        // docker-compose down -v / --volumes
        /\bdocker-compose\s+down\s+.*-(?:v|-volumes)\b/,
        // podman rm, podman rmi
        /\bpodman\s+(?:rm|rmi)\b/,
        // podman system prune
        /\bpodman\s+system\s+prune\b/,
    ];

    // ─────────────────────────────────────────────────────────────
    // 4) Package Removal
    // ────────────────────────────────────────────────────────────
    const pkgRemovalPatterns: RegExp[] = [
        // npm uninstall / remove / rm / prune
        /\bnpm\s+(?:uninstall|remove|rm|prune)\b/,
        // pnpm remove / prune
        /\bpnpm\s+(?:remove|prune)\b/,
        // yarn remove / autoclean
        /\byarn\s+(?:remove|autoclean)\b/,
        // bun remove
        /\bbun\s+remove\b/,
        // pip uninstall
        /\bpip\s+uninstall\b/,
        // uv remove
        /\buv\s+remove\b/,
        // cargo remove
        /\bcargo\s+remove\b/,
        // pacman -R / paru -R / yay -R
        /\b(?:pacman|paru|yay)\s+-R\b/,
        // apt remove / purge / autoremove
        /\bapt\s+(?:remove|purge|autoremove)\b/,
        // dnf remove
        /\bdnf\s+remove\b/,
    ];

    // ─────────────────────────────────────────────────────────────
    // 5) System State / Permissions
    // ────────────────────────────────────────────────────────────
    const sysStatePatterns: RegExp[] = [
        // sudo (privilege escalation)
        /\bsudo\s+/,

        // shutdown / reboot / poweroff
        /\b(?:shutdown|reboot|poweroff)\b/,

        // systemctl stop/disable/mask/restart
        /\bsystemctl\s+(?:stop|disable|mask|restart)\b/,

        // killall / pkill / kill -9 / kill -KILL / kill -SIGKILL
        /\bkillall\b/,
        /\bpkill\b/,
        /\bkill\s+-9\b/,
        /\bkill\s+-KILL\b/i,
        /\bkill\s+-SIGKILL\b/i,

        // mount / umount / swapon / swapoff
        /\b(?:mount|umount|swapon|swapoff)\s+/,

        // chmod/chown recursive
        /\bchmod\s+-R\b/,
        // chmod 777 / 0777 / a+rwx
        /\bchmod\s+(?:0?777|a\+rwx)\b/,
        // chown -R
        /\bchown\s+-R\b/,
        // setfacl recursive
        /\bsetfacl\s+-R\b/,
    ];

    // ─────────────────────────────────────────────────────────────
    // 9) SQL Destructive Operations
    // ────────────────────────────────────────────────────────────
    const sqlPatterns: RegExp[] = [
        // DROP DATABASE / SCHEMA / TABLE / INDEX
        /\bDROP\s+(?:DATABASE|SCHEMA|TABLE|INDEX)\b/i,
        // TRUNCATE / TRUNCATE TABLE
        /\bTRUNCATE\s+(?:TABLE\s+)?/i,
        // DELETE FROM ... (without WHERE)
        /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i,
        // UPDATE ... SET ... (without WHERE)
        /\bUPDATE\s+\w+\s+SET\b(?![\s\S]*\bWHERE\b)/i,
        // ALTER TABLE ... DROP COLUMN/CONSTRAINT
        /\bALTER\s+TABLE\s+\w+\s+DROP\s+(?:COLUMN|CONSTRAINT)\b/i,
    ];

    // ─────────────────────────────────────────────────────────────
    // Blocked patterns (no prompt, immediately rejected)
    // ────────────────────────────────────────────────────────────
    const blockedPatterns: RegExp[] = [
        // 6) Fork bomb: :(){ :|:& };:
        /:\(\)\s*\{[^}]*:\|:&\s*\};*\s*:/,

        // Fork bomb variants: function name followed by (){ ...:|:& ... }
        /\b\w+\s*\(\)\s*\{[^}]*:\|:&\s*\};*\s*:/,

        // 7) Writes to /etc/, /boot/, /sys/ via redirect
        />\s*\/etc\//,
        />\s*\/boot\//,
        />\s*\/sys\//,

        // Commands that directly write to system paths with redirect
        /\b(?:cat|echo|printf|tee|dd|cp|mv)\s+.*>\s*\/etc\//i,
        /\b(?:cat|echo|printf|tee|dd|cp|mv)\s+.*>\s*\/boot\//i,
        /\b(?:cat|echo|printf|tee|dd|cp|mv)\s+.*>\s*\/sys\//i,
        /\btee\s+\/etc\//i,
        /\btee\s+\/boot\//i,
        /\btee\s+\/sys\//i,
    ];

    // ─────────────────────────────────────────────────────────────
    // Prompted patterns (combined from all categories)
    // ────────────────────────────────────────────────────────────
    const promptedPatterns: RegExp[] = [
        ...gitPatterns,
        ...fsDestructPatterns,
        ...containerPatterns,
        ...pkgRemovalPatterns,
        ...sysStatePatterns,
        ...sqlPatterns,
    ];

    // ─────────────────────────────────────────────────────────────
    // 8) Secret File Access patterns
    // Intercepts cat, grep, rg, awk, sed, cp, mv, head, tail, less, more,
    // nl, wc, cut, sort, uniq, diff, vim, nano, code, bat, delta, xargs, find,
    // and other read/access-like tools targeting sensitive files.
    //
    // These are prompted (not blocked), because legitimate uses exist
    // (e.g., checking if a credential file exists or adjusting its contents).
    // ────────────────────────────────────────────────────────────
    const secretFileAccessPatterns: RegExp[] = [
        // .env, .env.* files (e.g., .env.local, .env.production)
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|nl|wc|cut|sort|uniq|diff|vim?|nano|code|bat|delta|xargs|find)\s+.*\.env(?:\.\w+)?\b/i,

        // .git-credentials
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|vim?|nano|code|bat|delta)\s+.*\.git-credentials\b/i,

        // auth.json
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|vim?|nano|code|bat|delta)\s+.*auth\.json\b/i,

        // id_rsa, id_ed25519 (SSH private keys)
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|vim?|nano|code|bat|delta)\s+.*id_(?:rsa|ed25519|dsa|ecdsa|ec384|ec521)\b/i,

        // .npmrc
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|vim?|nano|code|bat|delta)\s+.*\.npmrc\b/i,

        // .pypirc
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|vim?|nano|code|bat|delta)\s+.*\.pypirc\b/i,

        // .netrc
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|vim?|nano|code|bat|delta)\s+.*\.netrc\b/i,

        // .aws/credentials or .aws/config
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|vim?|nano|code|bat|delta)\s+.*\.aws\/(?:credentials|config)\b/i,

        // .kube/config
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|vim?|nano|code|bat|delta)\s+.*\.kube\/config\b/i,

        // .config/gh/hosts.yml
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|vim?|nano|code|bat|delta)\s+.*\.config\/gh\/hosts\.yml\b/i,

        // .config/gcloud/
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|vim?|nano|code|bat|delta)\s+.*\.config\/gcloud\//i,

        // .pem, .key, .p12, .kdbx
        /\b(?:cat|grep|rg|awk|sed|cp|mv|head|tail|less|more|vim?|nano|code|bat|delta)\s+.*\.(?:pem|key|p12|kdbx)\b/i,
    ];

    // ─────────────────────────────────────────────────────────────
    // 9) Protected Paths (intercepted in write/edit tool prompts)
    //
    // These are checked against the write and edit tool calls, not bash.
    // We also check bash commands that write to these paths.
    // ────────────────────────────────────────────────────────────
    const protectedPathsBashPatterns: RegExp[] = [
        // Write to ~/.ssh/ or .ssh/
        /(?:>>?)\s*.*\.ssh\//,
        /(?:tee|dd|cp|mv)\s+.*\.ssh\//i,

        // Write to .git-credentials
        /(?:>>?)\s*.*\.git-credentials/,
        /(?:tee|dd|cp|mv)\s+.*\.git-credentials/i,

        // Write to auth.json
        /(?:>>?)\s*.*auth\.json/,
        /(?:tee|dd|cp|mv)\s+.*auth\.json/i,

        // Write to id_rsa, id_ed25519, etc.
        /(?:>>?)\s*.*id_(?:rsa|ed25519|dsa|ecdsa|ec384|ec521)/,
        /(?:tee|dd|cp|mv)\s+.*id_(?:rsa|ed25519|dsa|ecdsa|ec384|ec521)/i,

        // Write to .env, .env.*, .envrc
        /(?:>>?)\s*.*\.env(?:\.\w+)?(?:\s|$)/,
        /(?:>>?)\s*.*\.envrc/,
        /(?:tee|dd|cp|mv)\s+.*\.env/i,

        // Write to .npmrc
        /(?:>>?)\s*.*\.npmrc/,
        /(?:tee|dd|cp|mv)\s+.*\.npmrc/i,

        // Write to .pypirc
        /(?:>>?)\s*.*\.pypirc/,
        /(?:tee|dd|cp|mv)\s+.*\.pypirc/i,

        // Write to .netrc
        /(?:>>?)\s*.*\.netrc/,
        /(?:tee|dd|cp|mv)\s+.*\.netrc/i,

        // Write to .kube/config
        /(?:>>?)\s*.*\.kube\/config/,
        /(?:tee|dd|cp|mv)\s+.*\.kube\/config/i,

        // Write to .aws/credentials or .aws/config
        /(?:>>?)\s*.*\.aws\/(?:credentials|config)/,
        /(?:tee|dd|cp|mv)\s+.*\.aws\/(?:credentials|config)/i,

        // Write to .config/gh/hosts.yml
        /(?:>>?)\s*.*\.config\/gh\/hosts\.yml/,
        /(?:tee|dd|cp|mv)\s+.*\.config\/gh\/hosts\.yml/i,

        // Write to .config/gcloud/
        /(?:>>?)\s*.*\.config\/gcloud\//,
        /(?:tee|dd|cp|mv)\s+.*\.config\/gcloud\//i,

        // Write to .pem, .key, .p12, .kdbx
        /(?:>>?)\s*.*\.(?:pem|key|p12|kdbx)(?:\s|$)/,
        /(?:tee|dd|cp|mv)\s+.*\.(?:pem|key|p12|kdbx)/i,
    ];

    // ─────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────

    function matchesAny(command: string, patterns: RegExp[]): boolean {
        return patterns.some((pattern) => pattern.test(command));
    }

    function formatCommand(cmd: string): string {
        if (cmd.length > 120) {
            return cmd.slice(0, 117) + "...";
        }
        return cmd;
    }

    /**
     * Categorize the dangerous pattern that matched, for a better user message.
     * Returns a label like "Git History Rewriting", "Filesystem Deletion", etc.
     */
    function categorize(command: string): string {
        // Check git patterns first (most specific)
        if (matchesAny(command, gitPatterns)) {
            if (/\bgit\s+reset\b/i.test(command)) return "Git History Rewriting";
            if (/\bgit\s+clean\b/i.test(command)) return "Git File Deletion";
            if (/\bgit\s+push\b/i.test(command)) return "Git Force Push";
            if (/\bgit\s+rebase\b/i.test(command)) return "Git Rebase";
            if (/\bgit\s+commit\b/i.test(command)) return "Git Amend/Fixup";
            if (/\bgit\s+filter-(?:branch|repo)\b/i.test(command)) return "Git Filter Rewrite";
            if (/\bgit\s+(?:branch|tag)\s+-d\b/i.test(command)) return "Git Branch/Tag Deletion";
            if (/\bgit\s+checkout|switch|restore\b/i.test(command)) return "Git Working Tree Change";
            return "Git Destructive Operation";
        }
        if (matchesAny(command, fsDestructPatterns)) return "Filesystem Deletion/Overwrite";
        if (matchesAny(command, containerPatterns)) return "Container Destruction";
        if (matchesAny(command, pkgRemovalPatterns)) return "Package Removal";
        if (matchesAny(command, sysStatePatterns)) return "System State Change";
        if (matchesAny(command, sqlPatterns)) return "SQL Destructive Operation";
        if (matchesAny(command, secretFileAccessPatterns)) return "Secret File Access";
        if (matchesAny(command, protectedPathsBashPatterns)) return "Protected Path Write";
        return "Dangerous Operation";
    }

    // ─────────────────────────────────────────────────────────────
    // Tool call interceptor
    // ────────────────────────────────────────────────────────────

    pi.on("tool_call", async (event, ctx) => {
        // ── Handle write tool ──────────────────────────────────
        if (event.toolName === "write") {
            const path = event.input.path as string | undefined;
            if (path) {
                // Check if writing to a protected path
                const protectedPaths = [
                    /\.ssh\//,
                    /\.git-credentials/,
                    /auth\.json/,
                    /id_(?:rsa|ed25519|dsa|ecdsa|ec384|ec521)(?:\.pub)?$/,
                    /\.env(?:\.\w+)?$/,
                    /\.envrc$/,
                    /\.npmrc$/,
                    /\.pypirc$/,
                    /\.netrc$/,
                    /\.kube\/config/,
                    /\.aws\/(?:credentials|config)/,
                    /\.config\/gh\/hosts\.yml/,
                    /\.config\/gcloud\//,
                    /\.(?:pem|key|p12|kdbx)$/,
                ];

                const isProtected = protectedPaths.some((pp) => pp.test(path));
                if (isProtected) {
                    if (!ctx.hasUI) {
                        return {
                            block: true,
                            reason: "Blocked by bash-safeguard: writing to protected path",
                        };
                    }

                    const ok = await ctx.ui.confirm(
                        "⚠️  Bash Safeguard — Protected Path Write",
                        `Path:\n  ${path}\n\nThis appears to be a sensitive/credential file.\nWrite content to this path? [y/N]`,
                    );

                    if (!ok) {
                        return {
                            block: true,
                            reason:
                                "User denied writing to protected path. Do not retry with alternate tools. Ask the user for guidance instead.",
                        };
                    }
                }
            }
        }

        // ── Handle edit tool ──────────────────────────────────
        if (event.toolName === "edit") {
            const path = event.input.path as string | undefined;
            if (path) {
                const protectedPaths = [
                    /\.ssh\//,
                    /\.git-credentials/,
                    /auth\.json/,
                    /id_(?:rsa|ed25519|dsa|ecdsa|ec384|ec521)(?:\.pub)?$/,
                    /\.env(?:\.\w+)?$/,
                    /\.envrc$/,
                    /\.npmrc$/,
                    /\.pypirc$/,
                    /\.netrc$/,
                    /\.kube\/config/,
                    /\.aws\/(?:credentials|config)/,
                    /\.config\/gh\/hosts\.yml/,
                    /\.config\/gcloud\//,
                    /\.(?:pem|key|p12|kdbx)$/,
                ];

                const isProtected = protectedPaths.some((pp) => pp.test(path));
                if (isProtected) {
                    if (!ctx.hasUI) {
                        return {
                            block: true,
                            reason: "Blocked by bash-safeguard: editing protected path",
                        };
                    }

                    const ok = await ctx.ui.confirm(
                        "⚠️  Bash Safeguard — Protected Path Edit",
                        `Path:\n  ${path}\n\nThis appears to be a sensitive/credential file.\nEdit this path? [y/N]`,
                    );

                    if (!ok) {
                        return {
                            block: true,
                            reason:
                                "User denied editing protected path. Do not retry with alternate tools. Ask the user for guidance instead.",
                        };
                    }
                }
            }
        }

        // ── Handle bash tool ──────────────────────────────────
        if (event.toolName !== "bash") return undefined;

        const { command } = event.input;
        if (typeof command !== "string") {
            return {
                block: true,
                reason: "Blocked due to command not being a proper string."
            }
        }

        // 1. Check for immediately-blocked patterns (no prompt)
        if (matchesAny(command, blockedPatterns)) {
            return {
                block: true,
                reason: "Blocked by bash-safeguard: this command is unconditionally forbidden.",
            };
        }

        // 2. Check for prompted bash patterns (git, fs, docker, pkg, system, sql)
        if (matchesAny(command, promptedPatterns)) {
            if (!ctx.hasUI) {
                // Non-interactive mode: block by default
                return {
                    block: true,
                    reason: "Blocked by bash-safeguard",
                };
            }

            const category = categorize(command);
            const formatted = formatCommand(command);

            const ok = await ctx.ui.confirm(
                `⚠️  Bash Safeguard — ${category}`,
                `Command:\n  ${formatted}\n\nRun this command? [y/N]`,
            );

            if (!ok) {
                return {
                    block: true,
                    reason:
                        "User denied this destructive operation. Do not retry with equivalent commands or alternate shell syntax. Ask the user for a safer non-destructive alternative instead.",
                };
            }
        }

        // 3. Check for secret file access patterns (bash)
        if (matchesAny(command, secretFileAccessPatterns)) {
            if (!ctx.hasUI) {
                return {
                    block: true,
                    reason: "Blocked by bash-safeguard",
                };
            }

            const formatted = formatCommand(command);
            const ok = await ctx.ui.confirm(
                "⚠️  Bash Safeguard — Secret File Access",
                `Command:\n  ${formatted}\n\nThis command reads sensitive/credential files.\nProceed? [y/N]`,
            );

            if (!ok) {
                return {
                    block: true,
                    reason:
                        "User denied accessing sensitive files. Do not retry with alternate tools. Ask the user if they intended to access these files.",
                };
            }
        }

        // 4. Check for protected path writes via bash
        if (matchesAny(command, protectedPathsBashPatterns)) {
            if (!ctx.hasUI) {
                return {
                    block: true,
                    reason: "Blocked by bash-safeguard",
                };
            }

            const formatted = formatCommand(command);
            const ok = await ctx.ui.confirm(
                "⚠️  Bash Safeguard — Protected Path Write",
                `Command:\n  ${formatted}\n\nThis command writes to a sensitive/credential path.\nProceed? [y/N]`,
            );

            if (!ok) {
                return {
                    block: true,
                    reason:
                        "User denied writing to protected path. Do not retry with alternate commands. Ask the user for guidance instead.",
                };
            }
        }

        return undefined;
    });
}
