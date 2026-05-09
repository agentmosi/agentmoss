import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const paperUrl = "https://www.preprints.org/manuscript/202604.1029";
const paperIntro = "我们计划发表的论文系统化介绍了 AgentMoss 的设计动机、运行时监控架构与 Agent 安全评估方法。";

async function readPublicPage(fileName: string): Promise<string> {
  return readFile(path.join(publicDir, fileName), "utf8");
}

test("about page footer links to the planned AgentMoss paper", async () => {
  const html = await readPublicPage("about.html");

  assert.match(html, /<footer[\s\S]*计划发表的论文/);
  assert.match(html, new RegExp(`<a[^>]+href=["']${paperUrl}["'][^>]*>`));
  assert.match(html, new RegExp(paperIntro));
});

test("homepage footer links to the planned AgentMoss paper", async () => {
  const html = await readPublicPage("index.html");

  assert.match(html, /<footer[\s\S]*计划发表的论文/);
  assert.match(html, new RegExp(`<a[^>]+href=["']${paperUrl}["'][^>]*>`));
  assert.match(html, new RegExp(paperIntro));
});
