// forms.get の JSON を、モデルが読む form.md に変換する(期初にフォームの項目が変わったときに実行)。
//   node scripts/dump-form.ts forms-get.json > skill/form.md
import { readFileSync } from "node:fs";

// Forms API の questionId は16進。prefill の entry ID はその10進表記。
export const entryId = (questionId: string) => BigInt(`0x${questionId}`).toString(10);

const ACTIONS: Record<string, string> = { NEXT_SECTION: "次のセクション", SUBMIT_FORM: "送信" };
const CHOICE: Record<string, string> = { RADIO: "単一選択", DROP_DOWN: "プルダウン", CHECKBOX: "複数選択(同じ entry を繰り返す)" };

function kind(q: any): string {
  if (q.choiceQuestion) return CHOICE[q.choiceQuestion.type] ?? q.choiceQuestion.type;
  if (q.textQuestion) return "記述";
  if (q.dateQuestion && !q.dateQuestion.includeTime) return "日付 YYYY-MM-DD";
  if (q.fileUploadQuestion) return "ファイル(prefill 不可・ブラウザで添付)";
  return "prefill 不可(ブラウザで入力)";
}

export function toMarkdown(form: any): string {
  const titles = new Map(form.items.filter((i: any) => i.pageBreakItem).map((i: any) => [i.itemId, i.title]));
  const lines = [
    `# ${form.info.title}`,
    "",
    `prefill URL: \`${form.responderUri}?usp=pp_url\` に \`&entry.<ID>=<値>\` を足す(値は URL エンコード)。`,
    "",
    "## (1ページ目)",
  ];
  for (const item of form.items) {
    if (item.pageBreakItem) {
      lines.push("", `## ${item.title}`);
      continue;
    }
    const q = item.questionItem?.question;
    if (!q) continue;
    const id = entryId(q.questionId);
    lines.push(`- ${item.title.replace(/\s+/g, " ")} \`entry.${id}\` ${q.required ? "必須" : "任意"}・${kind(q)}`);
    if (item.description) lines.push(`  - 説明: ${item.description.replace(/\s+/g, " ")}`);
    for (const o of q.choiceQuestion?.options ?? []) {
      const to = o.goToSectionId ? titles.get(o.goToSectionId) : o.goToAction && (ACTIONS[o.goToAction] ?? o.goToAction);
      const label = o.isOther ? `その他(自由記述: \`entry.${id}=__other_option__&entry.${id}.other_option_response=<値>\`)` : o.value;
      lines.push(`  - ${label}${to ? ` → ${to}` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

if (import.meta.main) process.stdout.write(toMarkdown(JSON.parse(readFileSync(process.argv[2], "utf8"))));
