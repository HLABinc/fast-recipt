// Forms API (forms.get) のレスポンスと同期設定から、入力時に使う静的なフォーム定義を作る。
//
// Forms API は「選択肢ごとの分岐先」は返すが「セクション末尾の移動先」は返さない。
// そのため予算の選び方は推定せず、同期設定(schema/sync-config.json)で範囲と続き方を明示し、
// 選択肢の分岐先だけから予算ツリーを組み立てる。作ったツリーは schema/form.json に保存し、差分で確認する。

export type FieldType =
  | "text"
  | "paragraph"
  | "radio"
  | "checkbox"
  | "dropdown"
  | "scale"
  | "date"
  | "time"
  | "file"
  | "unsupported";

export interface Field {
  /** prefill の entry ID(10進文字列) */
  id: string;
  title: string;
  description?: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  allowOther?: boolean;
  scale?: { low: number; high: number };
}

export interface SyncConfig {
  /** 予算の選択が始まるセクションのタイトル */
  budgetStart: string;
  /** 予算の選択が終わって合流するセクションのタイトル */
  budgetEnd: string;
  /** 選択肢による分岐がなく、そのまま次の予算セクションへ進むもの: タイトル → 次のタイトル */
  continue?: Record<string, string>;
}

/** 予算の選択肢ツリー。各ノードは 1 セクション 1 問 */
export interface BudgetNode {
  id: string;
  title: string;
  options: string[];
  /** 選択肢ごとの分岐先 */
  next?: Record<string, BudgetNode>;
  /** どの選択肢でも続けて答える質問(SyncConfig.continue) */
  then?: BudgetNode;
}

/** 予算以外の共通セクション */
export interface Section {
  title: string;
  fieldIds: string[];
  /** この回答のときだけ表示されるセクション */
  when?: { id: string; title: string; options: string[] };
}

export interface FormSchema {
  formId: string;
  title: string;
  /** https://docs.google.com/forms/d/e/<publishedId>/viewform */
  responderUri: string;
  revisionId?: string;
  syncedAt: string;
  sections: Section[];
  budget: BudgetNode;
  /** 予算の範囲内にあるが、どの選択肢からも辿れないセクション */
  unusedSections: string[];
  fields: Field[];
}

// Forms API の questionId は16進。prefill の entry ID はその10進表記。
export function questionIdToEntryId(questionId: string): string {
  return BigInt(`0x${questionId}`).toString(10);
}

const CHOICE_TYPES: Record<string, FieldType> = {
  RADIO: "radio",
  CHECKBOX: "checkbox",
  DROP_DOWN: "dropdown",
};

function questionToField(q: any, title: string, description: string | undefined): Field {
  const field: Field = {
    id: questionIdToEntryId(q.questionId),
    title,
    ...(description ? { description } : {}),
    type: "unsupported",
    required: Boolean(q.required),
  };

  if (q.choiceQuestion) {
    const opts = q.choiceQuestion.options ?? [];
    field.type = CHOICE_TYPES[q.choiceQuestion.type] ?? "unsupported";
    field.options = opts.filter((o: any) => !o.isOther).map((o: any) => o.value);
    if (opts.some((o: any) => o.isOther)) field.allowOther = true;
  } else if (q.textQuestion) {
    field.type = q.textQuestion.paragraph ? "paragraph" : "text";
  } else if (q.scaleQuestion) {
    field.type = "scale";
    field.scale = { low: q.scaleQuestion.low ?? 1, high: q.scaleQuestion.high };
  } else if (q.dateQuestion) {
    field.type = q.dateQuestion.includeTime ? "unsupported" : "date";
  } else if (q.timeQuestion) {
    field.type = q.timeQuestion.duration ? "unsupported" : "time";
  } else if (q.fileUploadQuestion) {
    field.type = "file";
  }
  return field;
}

/** 選択肢の分岐先。セクション番号か送信 */
type Target = number | "SUBMIT";

interface RawSection {
  title: string;
  itemId?: string;
  fields: Field[];
  /** entry ID → 選択肢 → 分岐先 */
  branches: Map<string, Record<string, Target>>;
}

function parseSections(form: any): RawSection[] {
  const sections: RawSection[] = [{ title: form.info?.title ?? "", fields: [], branches: new Map() }];
  const rawGoTo: [RawSection, number, Field, string, any][] = [];

  for (const item of form.items ?? []) {
    let current = sections[sections.length - 1];
    if (item.pageBreakItem) {
      sections.push({ title: item.title ?? "", itemId: item.itemId, fields: [], branches: new Map() });
    } else if (item.questionItem) {
      const q = item.questionItem.question;
      const field = questionToField(q, item.title ?? "", item.description);
      current.fields.push(field);
      for (const o of q.choiceQuestion?.options ?? []) {
        if (o.goToSectionId || o.goToAction) {
          rawGoTo.push([current, sections.length - 1, field, o.isOther ? "__other_option__" : o.value, o]);
        }
      }
    } else if (item.questionGroupItem) {
      // グリッドは行ごとに別の entry になる
      const columns = item.questionGroupItem.grid?.columns ?? {};
      for (const q of item.questionGroupItem.questions ?? []) {
        current.fields.push(
          questionToField({ ...q, choiceQuestion: columns }, `${item.title ?? ""} - ${q.rowQuestion?.title ?? ""}`, item.description),
        );
      }
    }
  }

  const byItemId = new Map(sections.map((s, i) => [s.itemId, i]));
  for (const [section, index, field, option, o] of rawGoTo) {
    let target: Target | undefined;
    if (o.goToSectionId) target = byItemId.get(o.goToSectionId);
    else if (o.goToAction === "NEXT_SECTION") target = index + 1;
    else if (o.goToAction === "SUBMIT_FORM") target = "SUBMIT";
    if (target === undefined) continue;
    const branches = section.branches.get(field.id) ?? {};
    branches[option] = target;
    section.branches.set(field.id, branches);
  }
  return sections;
}

export function fromFormsApi(form: any, config: SyncConfig, now = new Date()): FormSchema {
  const raw = parseSections(form);
  const indexOf = (title: string, label: string) => {
    const i = raw.findIndex((s) => s.title === title);
    if (i < 0) throw new Error(`${label}「${title}」というセクションがありません`);
    return i;
  };
  const start = indexOf(config.budgetStart, "budgetStart:");
  const end = indexOf(config.budgetEnd, "budgetEnd:");
  if (start >= end) throw new Error("budgetStart は budgetEnd より前のセクションにしてください");

  const used = new Set<number>();
  const budgetFields: Field[] = [];

  const buildNode = (index: number, trail: string[]): BudgetNode => {
    const s = raw[index];
    if (trail.includes(s.title)) throw new Error(`予算セクションが循環しています: ${[...trail, s.title].join(" → ")}`);
    const choices = s.fields.filter((f) => f.options);
    if (s.fields.length !== 1 || choices.length !== 1) {
      throw new Error(`予算セクション「${s.title}」は選択式の質問 1 問だけにしてください(現在 ${s.fields.length} 問)`);
    }
    const field = choices[0];
    used.add(index);
    budgetFields.push(field);

    const node: BudgetNode = { id: field.id, title: field.title, options: field.options! };
    for (const [option, target] of Object.entries(s.branches.get(field.id) ?? {})) {
      if (typeof target === "number" && target > start && target < end) {
        (node.next ??= {})[option] = buildNode(target, [...trail, s.title]);
      }
    }
    const cont = config.continue?.[s.title];
    if (cont) node.then = buildNode(indexOf(cont, `continue「${s.title}」の続き:`), [...trail, s.title]);
    return node;
  };
  const budget = buildNode(start, []);

  // 共通セクション。選択肢の分岐で入るセクションには表示条件を付ける
  const commonIndexes = raw.map((_, i) => i).filter((i) => i < start || i >= end);
  const sections: Section[] = commonIndexes.map((i) => {
    const section: Section = { title: raw[i].title, fieldIds: raw[i].fields.map((f) => f.id) };
    for (const j of commonIndexes) {
      for (const [id, branches] of raw[j].branches) {
        const options = Object.entries(branches).filter(([, t]) => t === i).map(([o]) => o);
        if (options.length && options.length < Object.keys(branches).length) {
          section.when = { id, title: raw[j].fields.find((f) => f.id === id)!.title, options };
        }
      }
    }
    return section;
  });

  return {
    formId: form.formId,
    title: form.info?.title ?? form.info?.documentTitle ?? "",
    responderUri: form.responderUri,
    revisionId: form.revisionId,
    syncedAt: now.toISOString(),
    sections,
    budget,
    unusedSections: raw.filter((_, i) => i > start && i < end && !used.has(i)).map((s) => s.title),
    fields: [...new Map([...commonIndexes.flatMap((i) => raw[i].fields), ...budgetFields].map((f) => [f.id, f])).values()],
  };
}
