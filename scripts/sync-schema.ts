// フォームの質問項目を schema/form.json に同期する(予算項目の更新時など、編集権限を持つ人が実行)。
//
//   node scripts/sync-schema.ts --form-id <ID>          # GOOGLE_ACCESS_TOKEN が必要
//   node scripts/sync-schema.ts --from forms-get.json   # API Explorer 等で取得した forms.get の JSON
//   オプション: --out <path>(既定 schema/form.json) / --config <path>(既定 schema/sync-config.json)
//
// 予算の範囲と続き方は sync-config.json で明示する。出力される予算ツリーを確認し、form.json の差分ごとコミットする。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { fromFormsApi, type BudgetNode, type FormSchema, type SyncConfig } from "../src/schema.ts";

const { values: args } = parseArgs({
  options: {
    "form-id": { type: "string" },
    from: { type: "string" },
    out: { type: "string", default: "schema/form.json" },
    config: { type: "string", default: "schema/sync-config.json" },
  },
});

async function fetchForm(formId: string): Promise<unknown> {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) throw new Error("GOOGLE_ACCESS_TOKEN が未設定です(scope: forms.body.readonly)");
  const res = await fetch(`https://forms.googleapis.com/v1/forms/${formId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`forms.get failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function diff(prev: FormSchema, next: FormSchema): string[] {
  const lines: string[] = [];
  const prevById = new Map(prev.fields.map((f) => [f.id, f]));
  const nextIds = new Set(next.fields.map((f) => f.id));
  for (const f of next.fields) {
    const old = prevById.get(f.id);
    if (!old) {
      lines.push(`+ ${f.title}`);
      continue;
    }
    const before = new Set(old.options ?? []);
    const after = new Set(f.options ?? []);
    const added = [...after].filter((o) => !before.has(o));
    const removed = [...before].filter((o) => !after.has(o));
    if (old.title !== f.title) lines.push(`~ ${old.title} → ${f.title}`);
    if (added.length || removed.length) {
      lines.push(`~ ${f.title}: 選択肢 +[${added.join(", ")}] -[${removed.join(", ")}]`);
    }
  }
  for (const f of prev.fields) if (!nextIds.has(f.id)) lines.push(`- ${f.title}`);
  return lines;
}

const raw = args.from
  ? JSON.parse(readFileSync(args.from, "utf8"))
  : args["form-id"]
    ? await fetchForm(args["form-id"])
    : (() => {
        throw new Error("--form-id か --from を指定してください");
      })();

const config: SyncConfig = JSON.parse(readFileSync(args.config!, "utf8"));
const schema = fromFormsApi(raw, config);
const out = args.out!;

if (existsSync(out)) {
  const changes = diff(JSON.parse(readFileSync(out, "utf8")), schema);
  console.log(changes.length ? changes.join("\n") : "変更なし");
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(schema, null, 2) + "\n");
console.log(`${schema.title}: ${schema.fields.length} 項目 → ${out}`);

function renderBudget(node: BudgetNode, indent = ""): string[] {
  const lines = [`${indent}${node.title}: ${node.options.join(" / ")}`];
  for (const [option, child] of Object.entries(node.next ?? {})) {
    lines.push(`${indent}  [${option}]`, ...renderBudget(child, indent + "    "));
  }
  if (node.then) lines.push(`${indent}  (続けて)`, ...renderBudget(node.then, indent + "    "));
  return lines;
}

console.log("\n予算ツリー:");
console.log(renderBudget(schema.budget, "  ").join("\n"));
for (const s of schema.sections) {
  if (s.when) console.log(`\n表示条件付き: 「${s.title}」は「${s.when.title}」が ${s.when.options.join(" / ")} のとき`);
}
if (schema.unusedSections.length) {
  console.log(`\nどの選択肢からも辿れない予算セクション(${schema.unusedSections.length}): ${schema.unusedSections.join(" / ")}`);
}
