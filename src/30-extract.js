// ========================= 11. 题目提取（含混淆字体探测） =========================

/** 题型关键词 → 归一化类型 */
const QUESTION_TYPES = [
	{ key: "单选题", match: /单选|单项选择/ },
	{ key: "多选题", match: /多选|多项选择|不定项/ },
	{ key: "判断题", match: /判断/ },
	{ key: "填空题", match: /填空/ },
	{ key: "简答题", match: /简答|论述|名词解释|计算题|分析题|问答题/ },
	{ key: "连线题", match: /连线|匹配/ },
	{ key: "排序题", match: /排序/ },
];

/** qtype 属性 → 归一化类型（页面辅助信息） */
const QTYPE_MAP = {
	0: "单选题",
	1: "多选题",
	2: "判断题",
	3: "填空题",
	4: "简答题",
	5: "简答题",
	6: "简答题",
	8: "连线题",
	9: "排序题",
};

function normalizeQuestionType(text, qtype) {
	const t = String(text || "");
	for (const def of QUESTION_TYPES) {
		if (def.match.test(t)) return def.key;
	}
	if (qtype != null && QTYPE_MAP[qtype]) return QTYPE_MAP[qtype];
	return "其他";
}

const Extract = {
	/**
	 * 从答题任务点 iframe 中定位真正的题目文档。
	 * 结构：work/index.html → iframe#frame_content → /mooc-ans/api/work 文档
	 */
	resolveWorkDoc(workIframe) {
		const workDoc = Dom.docOf(workIframe);
		if (!workDoc) return null;
		const inner = workDoc.querySelector(SEL.hiddenIframe);
		if (inner) {
			const d = Dom.docOf(inner);
			if (d) return d;
		}
		return workDoc; // 部分版本题目直接渲染在 work iframe 内
	},

	/** 等待题目文档与题目列表渲染完成 */
	async waitForQuestions(workIframe, timeout) {
		return waitFor(
			() => {
				const d = this.resolveWorkDoc(workIframe);
				if (!d) return null;
				if (!d.body || d.readyState !== "complete") return null;
				const list = d.querySelectorAll(SEL.question);
				if (!list.length) return null;
				// 至少有一道题具备题干结构，避免拿到骨架屏
				const ready = Dom.toArray(list).some((q) => q.querySelector(SEL.questionStemWrap));
				return ready ? d : null;
			},
			{
				timeout: timeout || CFG.workSettleTimeout,
				interval: 400,
				desc: "题目内容渲染",
			},
		);
	},

	/** 解析单道题 */
	parseQuestion(rootEl, idx, doc) {
		const typeEl = rootEl.querySelector(SEL.questionType);
		const stemEl = rootEl.querySelector(SEL.questionStem) || rootEl.querySelector(SEL.questionStemWrap);
		const firstOption = rootEl.querySelector(SEL.optionItem + "[qtype]");
		const qtype = firstOption ? firstOption.getAttribute("qtype") : null;

		const stemCloneText = stemEl ? Dom.normText(stemEl.textContent) : "";
		const typeText = typeEl ? Dom.normText(typeEl.textContent) : "";
		const typeKey = normalizeQuestionType(typeText, qtype);

		// 题干文本：剔除题型标签，避免污染
		let stemText = stemCloneText;
		if (typeText && stemText.startsWith(typeText)) stemText = stemText.slice(typeText.length).trim();

		const options = this.parseOptions(rootEl);
		const needBitmap =
			Dom.needsBitmap(stemEl) || options.some((o) => o.needBitmap);

		const parsed = {
			idx,
			seq: idx + 1,
			typeKey,
			qtype,
			rootEl,
			doc,
			stemEl,
			stemText,
			typeText,
			options,
			needBitmap,
			answered: options.some((o) => o.checked),
		};
		return parsed;
	},

	/** 解析选项列表 */
	parseOptions(rootEl) {
		const lists = Dom.toArray(rootEl.querySelectorAll(SEL.optionList));
		const out = [];
		lists.forEach((list) => {
			Dom.toArray(list.querySelectorAll(SEL.optionItem)).forEach((li) => {
				const labelEl = li.querySelector(SEL.optionLabel);
				const letter = labelEl
					? labelEl.getAttribute("data") || Dom.normText(labelEl.textContent)
					: "";
				if (!letter) return; // 非选项行（如说明文案）
				const bodyEl = li.querySelector(SEL.optionBody) || li;
				const imgCount = bodyEl.querySelectorAll("img").length;
				// 选项文本需排除字母标签本身
				const clone = bodyEl.cloneNode(true);
				const priceLabels = Dom.toArray(clone.querySelectorAll(SEL.optionLabel));
				priceLabels.forEach((n) => n.remove());
				const text = Dom.normText(clone.textContent);
				const checked = !!(
					(labelEl && labelEl.classList.contains("check_answer")) ||
					li.getAttribute("aria-checked") === "true" ||
					li.classList.contains("check_answer")
				);
				out.push({
					letter: String(letter).trim(),
					li,
					bodyEl,
					text,
					hasImage: imgCount > 0,
					imgCount,
					checked,
					needBitmap: Dom.needsBitmap(bodyEl),
				});
			});
		});
		return out;
	},

	/** 解析整个文档的所有题目 */
	parseAll(doc) {
		return Dom.toArray(doc.querySelectorAll(SEL.question)).map((q, i) =>
			this.parseQuestion(q, i, doc),
		);
	},
};
