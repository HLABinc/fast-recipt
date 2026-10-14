import type { BudgetNode, Field, FormSchema } from "./schema.ts";

export type AnswerValue = string | number | string[];
export type Answers = Record<string, AnswerValue>;

export interface PrefillResult {
  /** 値に不正がなければ prefill URL(必須漏れがあっても返す) */
  url?: string;
  /** 表示される必須項目と予算の選択がすべて埋まっているか */
  complete: boolean;
  errors: string[];
  /** 選んだ予算(予算ツリーの回答を順に並べたもの) */
  budget: string[];
  missingRequired: { id: string; title: string; type: string; options?: string[] }[];
  /** prefill できないので、ブラウザ操作で添付が必要な項目(表示されるもののみ) */
  fileFields: { id: string; title: string; required: boolean }[];
  warnings: string[];
}

const normalize = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

function findField(schema: FormSchema, key: string): Field | undefined {
  return (
    schema.fields.find((f) => f.id === key || `entry.${f.id}` === key) ??
    schema.fields.find((f) => f.title === key) ??
    schema.fields.find((f) => normalize(f.title) === normalize(key))
  );
}

function matchOption(field: Field, value: string): string | undefined {
  const opts = field.options ?? [];
  return opts.find((o) => o === value) ?? opts.find((o) => normalize(o) === normalize(value));
}

function formatOptions(field: Field): string {
  const opts = field.options ?? [];
  const shown = opts.slice(0, 30).join(" / ");
  return opts.length > 30 ? `${shown} / …他${opts.length - 30}件` : shown;
}

/** 1項目分の [key, value] ペアを返す。不正なら文字列でエラーを返す。 */
function encodeField(field: Field, raw: AnswerValue, warnings: string[]): [string, string][] | string {
  const key = `entry.${field.id}`;
  const values = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v).trim()).filter(Boolean);

  switch (field.type) {
    case "text":
    case "paragraph":
      return [[key, values.join(", ")]];

    case "radio":
    case "dropdown":
    case "checkbox": {
      if (field.type !== "checkbox" && values.length > 1) return `「${field.title}」は1つだけ選択できます`;
      const pairs: [string, string][] = [];
      const others: string[] = [];
      for (const v of values) {
        const opt = matchOption(field, v);
        if (opt) {
          if (opt !== v) warnings.push(`「${field.title}」: "${v}" を選択肢 "${opt}" として扱いました`);
          pairs.push([key, opt]);
        } else if (field.allowOther) {
          others.push(v);
        } else {
          return `「${field.title}」に "${v}" という選択肢はありません。選択肢: ${formatOptions(field)}`;
        }
      }
      if (others.length) {
        if (others.length > 1) return `「${field.title}」の「その他」は1つだけ指定できます`;
        pairs.push([key, "__other_option__"], [`${key}.other_option_response`, others[0]]);
      }
      return pairs;
    }

    case "scale": {
      const n = Number(values[0]);
      const { low, high } = field.scale!;
      if (!Number.isInteger(n) || n < low || n > high) return `「${field.title}」は ${low}〜${high} の整数です`;
      return [[key, String(n)]];
    }

    case "date": {
      const m = values[0]?.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
      if (!m) return `「${field.title}」は YYYY-MM-DD 形式で指定してください`;
      return [[key, `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`]];
    }

    case "time": {
      const m = values[0]?.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return `「${field.title}」は HH:MM 形式で指定してください`;
      return [[key, `${m[1].padStart(2, "0")}:${m[2]}`]];
    }

    case "file":
      return `「${field.title}」はファイル添付項目のため prefill できません。URL を開いたあと添付してください`;

    default:
      return `「${field.title}」は prefill 未対応の形式です。フォーム上で直接入力してください`;
  }
}

export function buildPrefill(schema: FormSchema, answers: Answers): PrefillResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const encodedById = new Map<string, [string, string][]>();

  for (const [k, v] of Object.entries(answers)) {
    const field = findField(schema, k);
    if (!field) {
      errors.push(`"${k}" に該当する質問がありません`);
      continue;
    }
    const encoded = encodeField(field, v, warnings);
    if (typeof encoded === "string") errors.push(encoded);
    else if (encoded.length && encoded.every(([, val]) => val !== "")) encodedById.set(field.id, encoded);
  }
  const selected = (id: string) => encodedById.get(id)?.[0]?.[1];
  const fieldById = new Map(schema.fields.map((f) => [f.id, f]));
  const toMissing = (f: { id: string; title: string; options?: string[] }) => ({
    id: f.id,
    title: f.title,
    type: fieldById.get(f.id)?.type ?? "radio",
    ...(f.options ? { options: f.options } : {}),
  });

  // 予算ツリーを回答どおりにたどる
  const visible = new Set<string>();
  const budget: string[] = [];
  const missingRequired: PrefillResult["missingRequired"] = [];
  let node: BudgetNode | undefined = schema.budget;
  while (node) {
    const choice = selected(node.id);
    if (choice === undefined) {
      missingRequired.push(toMissing(node));
      break;
    }
    visible.add(node.id);
    budget.push(choice);
    node = node.next?.[choice] ?? node.then;
  }

  // 共通セクションは、表示条件を満たすものだけ
  const shown = schema.sections.filter((s) => !s.when || s.when.options.includes(selected(s.when.id) ?? ""));
  for (const s of shown) for (const id of s.fieldIds) visible.add(id);

  const params = new URLSearchParams({ usp: "pp_url" });
  for (const [id, encoded] of encodedById) {
    if (!visible.has(id)) {
      warnings.push(`「${fieldById.get(id)!.title}」は今回の回答では表示されないため URL に含めませんでした`);
      continue;
    }
    for (const [pk, pv] of encoded) params.append(pk, pv);
  }

  const shownFields = shown.flatMap((s) => s.fieldIds.map((id) => fieldById.get(id)!));
  missingRequired.unshift(
    ...shownFields.filter((f) => f.required && f.type !== "file" && !encodedById.has(f.id)).map(toMissing),
  );
  const fileFields = shownFields
    .filter((f) => f.type === "file")
    .map((f) => ({ id: f.id, title: f.title, required: f.required }));

  return {
    ...(errors.length === 0 ? { url: `${schema.responderUri}?${params.toString()}` } : {}),
    complete: errors.length === 0 && missingRequired.length === 0,
    errors,
    budget,
    missingRequired,
    fileFields,
    warnings,
  };
}
