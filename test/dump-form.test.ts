import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entryId, toMarkdown } from "../scripts/dump-form.ts";

test("forms.get → form.md", () => {
  assert.equal(entryId("189ba9d9"), "412854745"); // 実フォームの返金銀行口座登録
  const md = toMarkdown(JSON.parse(readFileSync(new URL("fixtures/forms-get.json", import.meta.url), "utf8")));
  assert.match(md, /^- 口座登録 `entry\.439041101` 必須・単一選択$/m);
  assert.match(md, /^  - 登録済み → 予算選択$/m);
  assert.match(md, /^  - 未登録 → 次のセクション$/m);
  assert.match(md, /^  - 不要 → 送信$/m);
  assert.match(md, /^- 購入日付 `entry\.128` 必須・日付 YYYY-MM-DD$/m);
  assert.match(md, /entry\.144=__other_option__&entry\.144\.other_option_response=<値>/);
  assert.match(md, /^- レシート `entry\.208` 必須・ファイル/m);
});
