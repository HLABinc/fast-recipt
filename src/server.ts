import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildPrefill } from "./prefill.ts";
import type { FormSchema } from "./schema.ts";

const DEFAULT_SCHEMA = fileURLToPath(new URL("../schema/form.json", import.meta.url));

export function loadSchema(path = process.env.EXPENSE_FORM_SCHEMA ?? DEFAULT_SCHEMA): FormSchema {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** モデルに渡すフォーム定義。共通セクションの質問と予算ツリー */
export function describeForm(schema: FormSchema) {
  const fieldById = new Map(schema.fields.map((f) => [f.id, f]));
  return {
    sections: schema.sections.map((s) => ({
      title: s.title,
      ...(s.when ? { shownWhen: { question: s.when.title, answerIn: s.when.options } } : {}),
      fields: s.fieldIds.map((id) => fieldById.get(id)),
    })),
    budget: schema.budget,
  };
}

const INSTRUCTIONS = `経費申請 Google フォームを最短で埋めるためのツール。
手順:
1. get_expense_form で質問項目と選択肢を確認する。
   - sections: 共通の質問。shownWhen があるセクションは、その回答のときだけ表示される。
   - budget: 予算の選択肢ツリー。ルートから回答し、next[選んだ選択肢] があればその質問へ、なければ then の質問へ進む。
2. レシート画像から読み取れる項目(日付・金額・支払先・但し書きなど)を埋める。
3. 目的・案件・同行者など画像から分からない項目は、Slack コネクタが使えれば日付・店名・金額で検索して推定する。
4. それでも埋まらない必須項目だけを、選択肢付きで 1 回にまとめてユーザーに質問する。推定した値は確認時に一覧で見せる。
5. build_expense_prefill_url で URL を作る。errors があれば直し、complete が false なら missingRequired を埋めて再実行する。
6. URL をブラウザ(Claude in Chrome / computer use / ChatGPT agent 等)で開く。
   - 「Continue current draft? / 下書きを使用しますか」と出たら「Continue / 続行」を選ぶ(古い下書きではなく prefill を使う)。
   - メールアドレス記録のチェックボックスなど prefill できない項目はここで入力する。
   - 「次へ」で進めながら prefill 済みの値を確認し、fileFields の項目にレシートを添付する。ページ表示直後は選択が未反映に見えることがあるので、読み込みを待ってから確認する。
7. 送信ボタンはユーザーの明示的な確認なしに押さない。`;

export function createServer(schema: FormSchema = loadSchema()): McpServer {
  const server = new McpServer({ name: "fast-receipt", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get_expense_form",
    {
      title: "経費申請フォームの質問項目を取得",
      description:
        "経費申請フォームの質問項目(entry ID・種類・必須・選択肢)と入力手順を返す。経費申請を始めるときに最初に呼ぶ。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const payload = {
        title: schema.title,
        syncedAt: schema.syncedAt,
        ...describeForm(schema),
        howTo: INSTRUCTIONS,
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  );

  server.registerTool(
    "build_expense_prefill_url",
    {
      title: "経費申請の入力済み URL を作成",
      description:
        "回答を検証し、経費申請フォームの prefill URL を返す。answers のキーは entry ID か質問タイトル(予算ツリーの質問も同様)。日付は YYYY-MM-DD、複数選択は配列、選択肢にない値は「その他」がある項目のみ可。選んだ予算(budget)と、表示される質問のうち未回答の必須項目(missingRequired)も返す。不正値があれば url は返らない。",
      inputSchema: {
        answers: z
          .record(z.string(), z.union([z.string(), z.number(), z.array(z.string())]))
          .describe('例: {"123456789": "2026-10-14", "利用金額": 1200, "予算項目": "交通費"}'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ answers }) => {
      const result = buildPrefill(schema, answers);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.errors.length > 0,
      };
    },
  );

  return server;
}
