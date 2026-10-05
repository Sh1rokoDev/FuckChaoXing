/**
 * 构建脚本：把 src/ 下的模块按文件名顺序拼接为单文件用户脚本。
 * 用法：node build.mjs [--watch]
 *
 * 模块约定：
 *   - 每个文件是一段可直接拼接的 JS 片段（无 import/export）
 *   - 00-header.js 的内容（元数据块 + 调研注释）输出在 IIFE 之外，其余文件包裹进同一个 IIFE
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src");
const OUTPUT = join(ROOT, "chaoxing-video-autoplayer.user.js");
const HEADER_FILE = "00-header.js";

function listModules() {
	return readdirSync(SRC)
		.filter((f) => f.endsWith(".js") && statSync(join(SRC, f)).isFile())
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function build() {
	const files = listModules();
	if (!files.length) throw new Error("src/ 下没有找到任何模块文件");
	if (files[0] !== HEADER_FILE)
		throw new Error("第一个模块必须是 " + HEADER_FILE + "，当前为 " + files[0]);

	const header = readFileSync(join(SRC, HEADER_FILE), "utf8").trimEnd();
	const body = files
		.slice(1)
		.map((f) => {
			const code = readFileSync(join(SRC, f), "utf8").trimEnd();
			return "// >>> " + f + "\n" + code;
		})
		.join("\n\n");

	const out =
		header +
		"\n\n(function () {\n\t\"use strict\";\n\n" +
		indent(body, 1) +
		"\n})();\n";

	writeFileSync(OUTPUT, out, "utf8");
	const kb = (Buffer.byteLength(out, "utf8") / 1024).toFixed(1);
	console.log(
		`[build] ${files.length} modules -> ${basename(OUTPUT)} (${kb} KB, ${out.split("\n").length} lines)`,
	);
	return OUTPUT;
}

/** 整体缩进一级，保持产物可读 */
function indent(text, level) {
	const pad = "\t".repeat(level);
	return text
		.split("\n")
		.map((line) => (line.trim() ? pad + line : line))
		.join("\n");
}

build();

if (process.argv.includes("--watch")) {
	console.log("[build] watching src/ for changes…");
	let timer = null;
	readdirSync(SRC).forEach(() => {});
	setInterval(() => {
		try {
			const files = listModules();
			const stamp = files
				.map((f) => f + ":" + statSync(join(SRC, f)).mtimeMs)
				.join("|");
			if (stamp !== globalThis.__lastStamp) {
				if (globalThis.__lastStamp !== undefined) {
					if (timer) clearTimeout(timer);
					timer = setTimeout(() => {
						try {
							build();
						} catch (e) {
							console.error("[build] 失败：" + e.message);
						}
					}, 120);
				}
				globalThis.__lastStamp = stamp;
			}
		} catch (e) {
			/* 忽略瞬时读取错误 */
		}
	}, 400);
}
