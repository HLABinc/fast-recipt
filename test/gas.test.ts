import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// GAS のファイルはモジュールではないので、グローバルとして読み込む
const ctx: any = {};
vm.runInNewContext(readFileSync(new URL("../gas/Code.js", import.meta.url), "utf8") + "\nthis.f = { budgetRows, rewriteSumifs, shouldSync };", ctx);
const { budgetRows, rewriteSumifs, shouldSync } = ctx.f;

test("budgetRows: 集計式のある行だけ、A 列が空ならブロック見出しを予算名に", () => {
  const values = [
    ["", "26年度後期マイプロ_映画交流会", ""],
    ["", "予算項目", "予算額"],
    ["", "映画交流会", "¥1,000"],
    ["", "合計", "¥1,000"],
    ["", "クラブA", ""],
    ["", "予算項目", "予算額"],
    ["26年度後期クラブA", "活動支援金", "¥2,000"],
  ];
  const pc = "=SUMIFS('プロセスチェックシート'!C103:C103)";
  const formulas = [["", "", ""], ["", "", ""], ["", "", pc], ["", "", "=SUM(C3)"], ["", "", ""], ["", "", ""], ["", "", pc]];
  assert.deepEqual(JSON.parse(JSON.stringify(budgetRows(values, formulas))), [
    ["26年度後期マイプロ_映画交流会", "映画交流会"],
    ["26年度後期クラブA", "活動支援金"],
  ]);
});

test("rewriteSumifs: 名前列と項目列だけを集計用の列に差し替える", () => {
  const P = "'プロセスチェックシート'!";
  const f = `=SUMIFS(${P}C103:C103,${P}C22:C22,R[0]C1,${P}C26:C26,R[0]C2,${P}C88:C88,TRUE)`;
  assert.equal(rewriteSumifs(f, [20, 22, 35, 55], 112, 113),
    `=SUMIFS(${P}C103:C103,${P}C112:C112,R[0]C1,${P}C113:C113,R[0]C2,${P}C88:C88,TRUE)`);
  // 項目条件が無い(マイプロ)なら名前だけ
  assert.equal(rewriteSumifs(`=SUMIFS(${P}C103:C103,${P}C55:C55,R[-2]C2,${P}C89:C89,TRUE)`, [55], 112, 113),
    `=SUMIFS(${P}C103:C103,${P}C112:C112,R[-2]C2,${P}C89:C89,TRUE)`);
  // 金額列や名前列が違う式(既に壊れている)は触らない
  assert.equal(rewriteSumifs(`=SUMIFS(${P}C81:C81,${P}C11:C11,R[0]C1)`, [22], 112, 113), null);
});

test("shouldSync: 予算タブの編集と行・タブの変更だけ", () => {
  assert.equal(shouldSync("EDIT", "26年度後期委員会別予算"), true);
  assert.equal(shouldSync("EDIT", "26年度ハウス予算"), true);
  assert.equal(shouldSync("EDIT", "プロセスチェックシート"), false); // 承認・払い戻しの入力
  assert.equal(shouldSync("FORMAT", "26年度後期クラブ別予算"), false);
  assert.equal(shouldSync("REMOVE_ROW", "どこでも"), true);
  assert.equal(shouldSync("OTHER", "どこでも"), true); // タブの非表示
});
