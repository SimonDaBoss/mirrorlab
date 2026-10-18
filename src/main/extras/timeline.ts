import fs from "node:fs";
import path from "node:path";
import type { TimelineEntry } from "../../shared/types";

/**
 * Per-device evidence timeline: every input (yours or the agent's), notes and
 * screenshots, in order, saved to disk as you go. Export renders a
 * self-contained HTML report you can hand to someone else.
 */
export class Timeline {
  readonly entries: TimelineEntry[] = [];
  readonly dir: string;
  private shotCount = 0;
  private listeners = new Set<(e: TimelineEntry) => void>();

  constructor(root: string, readonly serial: string, readonly deviceName: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.dir = path.join(root, `${stamp}_${serial.replace(/[^\w.-]/g, "_")}`);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  onEntry(fn: (e: TimelineEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  add(source: TimelineEntry["source"], kind: string, detail: string, png?: Buffer): TimelineEntry {
    const e: TimelineEntry = { t: Date.now(), source, kind, detail };
    if (png) {
      e.screenshot = `shot-${String(++this.shotCount).padStart(4, "0")}.png`;
      fs.writeFileSync(path.join(this.dir, e.screenshot), png);
    }
    this.entries.push(e);
    fs.appendFileSync(path.join(this.dir, "timeline.jsonl"), JSON.stringify(e) + "\n");
    for (const l of this.listeners) l(e);
    return e;
  }

  format(limit = 50): string {
    return this.entries
      .slice(-limit)
      .map((e) => `${new Date(e.t).toISOString().slice(11, 23)} [${e.source}] ${e.kind}: ${e.detail}${e.screenshot ? ` (${e.screenshot})` : ""}`)
      .join("\n");
  }

  exportHtml(): string {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const rows = this.entries
      .map((e) => {
        const img = e.screenshot
          ? `<img loading="lazy" src="data:image/png;base64,${fs.readFileSync(path.join(this.dir, e.screenshot)).toString("base64")}">`
          : "";
        return `<li class="${e.source}"><time>${new Date(e.t).toLocaleTimeString()}</time><b>${esc(e.kind)}</b><span class="src">${e.source}</span><p>${esc(e.detail)}</p>${img}</li>`;
      })
      .join("\n");
    const html = `<!doctype html><meta charset="utf-8"><title>Mirrorlab timeline — ${esc(this.deviceName)}</title>
<style>
:root{--bg:#f6f7f9;--fg:#15171a;--muted:#667;--card:#fff;--line:#dde1e6;--user:#2563eb;--agent:#9333ea;--system:#64748b}
@media (prefers-color-scheme:dark){:root{--bg:#0f1114;--fg:#e8eaed;--muted:#99a;--card:#181b20;--line:#2a2f36}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0}.sub{color:var(--muted);margin:4px 0 24px}
ol{list-style:none;padding:0;margin:0;border-left:2px solid var(--line)}
li{position:relative;margin:0 0 16px 16px;padding:12px 14px;background:var(--card);border:1px solid var(--line);border-radius:8px}
li::before{content:"";position:absolute;left:-23px;top:16px;width:10px;height:10px;border-radius:50%;background:var(--system)}
li.user::before{background:var(--user)}li.agent::before{background:var(--agent)}
time{color:var(--muted);font:12px ui-monospace,monospace;margin-right:8px}.src{float:right;color:var(--muted);font-size:12px}
p{margin:4px 0 0;white-space:pre-wrap;word-break:break-word}img{display:block;max-width:240px;margin-top:8px;border-radius:6px;border:1px solid var(--line)}
</style>
<h1>${esc(this.deviceName)} <small style="color:var(--muted);font-weight:400">${esc(this.serial)}</small></h1>
<p class="sub">${this.entries.length} events · ${this.entries[0] ? new Date(this.entries[0].t).toLocaleString() : ""}</p>
<ol>${rows}</ol>`;
    const file = path.join(this.dir, "report.html");
    fs.writeFileSync(file, html);
    return file;
  }
}
