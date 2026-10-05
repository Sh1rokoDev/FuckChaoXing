// ========================= 16. 答案填充（选项点选 / 填空写入） =========================

const Fill = {
	/** 选项字母归一化（A/B/C…，容忍全角、带点、空格、小写） */
	normLetter(s) {
		return String(s || "")
			.replace(/[\s.、,，。;；:：]/g, "")
			.replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
			.toUpperCase();
	},

	/** 把答案文本拆成选项字母数组 */
	splitLetters(answer) {
		const s = this.normLetter(answer);
		const letters = s.match(/[A-Z]/g);
		if (letters && letters.length) return Array.from(new Set(letters));
		// 数字型选项（1/2/3/4 作为 A/B/C/D 的替代写法）
		const digits = s.match(/[0-9]+/g);
		if (digits && digits.length) {
			return Array.from(
				new Set(
					digits
						.map((d) => parseInt(d, 10) - 1)
						.filter((n) => n >= 0 && n < 26)
						.map((n) => String.fromCharCode(65 + n)),
				),
			);
		}
		return [];
	},

	/** 判断某个选项当前是否处于选中态 */
	isChecked(opt) {
		const label = opt.li.querySelector(SEL.optionLabel);
		return !!(
			(label && label.classList.contains("check_answer")) ||
			opt.li.getAttribute("aria-checked") === "true" ||
			opt.li.classList.contains("check_answer")
		);
	},

	/** 点选单个选项（优先复用页面自身的 addChoice，保证内部状态同步） */
	clickOption(question, opt) {
		const win = question.doc && question.doc.defaultView;
		try {
			if (win && typeof win.addChoice === "function") {
				win.addChoice(opt.li);
				return true;
			}
		} catch (e) {
			/* 回退到原生点击 */
		}
		try {
			opt.li.click();
			return true;
		} catch (e2) {
			return false;
		}
	},

	/** 根据答案文本作答某道选择题 */
	async applyChoiceAnswer(question, answer) {
		const letters = this.splitLetters(answer);
		if (!letters.length) return { ok: false, reason: "无法解析选项字母" };
		const byLetter = new Map();
		question.options.forEach((o) => byLetter.set(this.normLetter(o.letter), o));

		const targets = letters.map((l) => byLetter.get(l)).filter(Boolean);
		if (!targets.length)
			return {
				ok: false,
				reason: "答案字母不在本题选项中（" + letters.join("") + "）",
			};

		const isMulti = question.typeKey === "多选题";
		// 单选/判断题：确保目标唯一选中
		if (!isMulti) {
			const target = targets[0];
			if (!this.isChecked(target)) {
				this.clickOption(question, target);
				await sleep(CFG.fillVerifyDelay);
			}
			// 取消其它误选项
			for (const opt of question.options) {
				if (opt === target) continue;
				if (this.isChecked(opt)) {
					this.clickOption(question, opt);
					await sleep(CFG.fillVerifyDelay);
				}
			}
			const ok = this.isChecked(target);
			return { ok, reason: ok ? "" : "点选未生效", picked: [target.letter] };
		}

		// 多选：先选目标，再清掉非目标
		for (const opt of targets) {
			if (!this.isChecked(opt)) {
				this.clickOption(question, opt);
				await sleep(CFG.fillVerifyDelay);
			}
		}
		for (const opt of question.options) {
			if (targets.indexOf(opt) !== -1) continue;
			if (this.isChecked(opt)) {
				this.clickOption(question, opt);
				await sleep(CFG.fillVerifyDelay);
			}
		}
		const picked = targets.filter((o) => this.isChecked(o)).map((o) => o.letter);
		return {
			ok: picked.length === targets.length,
			reason: picked.length === targets.length ? "" : "部分选项未生效",
			picked,
		};
	},

	/** 统一入口：按题型分派（仅支持单选 / 多选 / 判断） */
	async apply(question, answer) {
		if (!question.options || !question.options.length)
			return { ok: false, reason: "该题型不支持自动作答（仅支持单选/多选/判断）" };
		return this.applyChoiceAnswer(question, answer);
	},
};
