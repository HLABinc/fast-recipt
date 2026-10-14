import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromFormsApi, questionIdToEntryId, type SyncConfig } from "../src/schema.ts";
import { buildPrefill } from "../src/prefill.ts";

const form = JSON.parse(readFileSync(new URL("./fixtures/forms-get.json", import.meta.url), "utf8"));
const config: SyncConfig = { budgetStart: "予算選択", budgetEnd: "費用詳細入力", continue: { ハウス選択: "ハウス予算項目選択" } };
const schema = fromFormsApi(form, config);

const house = { 口座登録: "登録済み", 予算選択: "ハウス予算", ハウス名: "ハウスA", ハウス予算項目: "イベント①" };
const detail = { 購入日付: "2026/10/1", 勘定科目: "交通費", 金額: 1200, レシート写真の必要性: "不要" };

test("questionId(16進)を entry ID(10進)に変換する", () => {
  assert.equal(questionIdToEntryId("1a2b3c4d"), "439041101");
});

test("選択肢の分岐先と continue から予算ツリーを作る", () => {
  const root = schema.budget;
  assert.equal(root.title, "予算選択");
  assert.deepEqual(Object.keys(root.next!), ["ハウス予算", "クラブ予算"]);
  assert.equal(root.next!["ハウス予算"].title, "ハウス名");
  assert.equal(root.next!["ハウス予算"].then!.title, "ハウス予算項目");
  assert.equal(root.next!["クラブ予算"].next!["茶道部"].title, "茶道部予算項目");
  assert.deepEqual(schema.unusedSections, ["旧クラブ予算項目"]);
});

test("共通セクションには選択肢の分岐から表示条件を付ける", () => {
  assert.deepEqual(
    schema.sections.map((s) => [s.title, s.when?.options]),
    [
      ["経費申請フォーム(テスト)", undefined],
      ["振込口座登録", ["未登録"]],
      ["費用詳細入力", undefined],
      ["アップロード", ["必要"]],
    ],
  );
});

test("同期設定のセクション名が違えばエラーにする", () => {
  assert.throws(() => fromFormsApi(form, { ...config, budgetEnd: "費用入力" }), /budgetEnd:「費用入力」/);
  assert.throws(() => fromFormsApi(form, { ...config, budgetStart: "費用詳細入力", budgetEnd: "予算選択" }), /より前/);
});

test("予算と必須項目がそろえば complete", () => {
  const r = buildPrefill(schema, { ...house, ...detail });
  assert.deepEqual(r.budget, ["ハウス予算", "ハウスA", "イベント①"]);
  assert.deepEqual(r.missingRequired, []);
  assert.equal(r.complete, true);

  const club = buildPrefill(schema, { ...house, 予算選択: "クラブ予算", クラブ名: "茶道部", 茶道部予算項目: "茶道部", ...detail });
  assert.deepEqual(club.budget, ["クラブ予算", "茶道部", "茶道部"]);
  assert.equal(club.complete, true);
});

test("予算ツリーの途中で未回答なら、その質問を選択肢付きで返す", () => {
  const r = buildPrefill(schema, { 口座登録: "登録済み", 予算選択: "ハウス予算", ...detail });
  assert.deepEqual(r.missingRequired, [{ id: "48", title: "ハウス名", type: "radio", options: ["ハウスA", "ハウスB"] }]);
  assert.equal(r.complete, false);
});

test("選んだ予算以外の予算回答は URL に含めない", () => {
  const r = buildPrefill(schema, { ...house, ...detail, クラブ名: "茶道部" });
  assert.equal(new URL(r.url!).searchParams.has("entry.80"), false);
  assert.match(r.warnings.join(), /クラブ名/);
});

test("表示条件付きセクションは条件を満たすときだけ必須になる", () => {
  const unregistered = buildPrefill(schema, { ...house, ...detail, 口座登録: "未登録" });
  assert.deepEqual(unregistered.missingRequired.map((m) => m.title), ["銀行名"]);

  const registered = buildPrefill(schema, { ...house, ...detail, 銀行名: "みずほ" });
  assert.equal(registered.complete, true);
  assert.equal(new URL(registered.url!).searchParams.has("entry.16"), false);
});

test("レシート必要ならアップロード項目と後続の必須項目が出る", () => {
  const r = buildPrefill(schema, { ...house, ...detail, レシート写真の必要性: "必要" });
  assert.deepEqual(r.fileFields, [{ id: "208", title: "レシート", required: true }]);
  assert.deepEqual(r.missingRequired.map((m) => m.title), ["インボイス番号"]);
  assert.deepEqual(buildPrefill(schema, { ...house, ...detail }).fileFields, []);
});

test("prefill URL の形式", () => {
  const url = new URL(buildPrefill(schema, { ...house, ...detail }).url!);
  assert.equal(url.origin + url.pathname, "https://docs.google.com/forms/d/e/1FAIpQLTEST/viewform");
  assert.equal(url.searchParams.get("usp"), "pp_url");
  assert.equal(url.searchParams.get("entry.439041101"), "登録済み");
  assert.equal(url.searchParams.get("entry.32"), "ハウス予算");
  assert.equal(url.searchParams.get("entry.128"), "2026-10-01");
  assert.equal(url.searchParams.get("entry.176"), "1200");
});

test("選択肢にない値はエラー、「その他」があれば other で送る", () => {
  assert.match(buildPrefill(schema, { ...house, 予算選択: "部活" }).errors[0], /選択肢: ハウス予算 \/ クラブ予算/);

  const url = new URL(buildPrefill(schema, { ...house, ...detail, 勘定科目: "会議費" }).url!);
  assert.equal(url.searchParams.get("entry.144"), "__other_option__");
  assert.equal(url.searchParams.get("entry.144.other_option_response"), "会議費");
});

test("チェックボックスは同じキーを繰り返し、表記ゆれは正規化する", () => {
  const r = buildPrefill(schema, { ...house, ...detail, 用途: ["研究", "イベント"], "entry.144": "交通費 " });
  const params = new URL(r.url!).searchParams;
  assert.deepEqual(params.getAll("entry.160"), ["研究", "イベント"]);
  assert.equal(params.get("entry.144"), "交通費");
});

test("ファイル項目・不明キー・不正日付はエラーで URL を返さない", () => {
  const r = buildPrefill(schema, { ...house, ...detail, レシート: "a.jpg", 謎: "x", 購入日付: "10月1日" });
  assert.equal(r.errors.length, 3);
  assert.equal(r.url, undefined);
});
