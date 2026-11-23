// 経費申請フォームの予算選択を「予算タブ → フォームの選択肢」で同期し、AI 向けにフォームの構成(manifest)を返す。
// 本番 ID は config.js(git 管理外)の PROD_FORM_ID / PROD_SHEET_ID。

const SEP = '｜'; // 委員会・クラブ・マイプロの選択肢は「予算名｜予算項目」
const RESP_TAB = 'フォームの回答';
const PC_TAB = 'プロセスチェックシート';
const AMOUNT_COL = 103; // プロセスチェックシート CY 列 = 精算金額(int)
const CHECK_COLS = [88, 89]; // CJ = 承認, CK = 払い戻し
const KINDS = {
  // 予算選択の値: 答えるセクション、名前の質問、(ハウスのみ)項目の質問、予算タブ名
  'ハウス予算': { section: 'ハウス選択', name: 'ハウス名', item: 'ハウス予算項目', tab: /ハウス予算$/ },
  '委員会予算': { section: '委員会選択', name: '委員会名選択', tab: /委員会別予算$/ },
  'クラブ予算': { section: 'クラブ名選択', name: 'クラブ名選択', tab: /クラブ別予算$/ },
  'マイプロジェクト予算': { section: 'マイプロジェクト選択', name: 'マイプロジェクト選択', tab: /マイプロ別予算$/ },
};
const KEEP_SECTIONS = ['振込口座登録', '予算選択', ...Object.values(KINDS).map(k => k.section), '費用詳細入力', 'レシート写真・領収書写真/PDFのアップロード'];

// ---------- 純粋関数(test/gas.test.ts で検証) ----------

// 予算タブの行から [予算名, 予算項目] を取り出す。集計式(プロセスチェックシート参照)がある行だけが予算項目。
// A 列が空の行はブロック見出し(「予算項目」行の 1 つ上の B 列)を予算名にする。
function budgetRows(values, formulas) {
  const out = [];
  let title = '';
  values.forEach((r, i) => {
    if (values[i + 1] && values[i + 1][1] === '予算項目') title = r[1];
    if (r[1] && formulas[i].some(f => f.includes(PC_TAB))) out.push([r[0] || title, r[1]]);
  });
  return out;
}

// 予算タブの SUMIFS(R1C1)の照合列を、名前列 → 集計用予算名列、項目列 → 集計用項目列に差し替える。
// 金額列が AMOUNT_COL でない式や、名前列で照合していない式は既に壊れているので触らない(null)。
function rewriteSumifs(f, nameCols, nameCol, itemCol) {
  const re = /'プロセスチェックシート'!C(\d+):C\1/g;
  const cols = [...f.matchAll(re)].map(m => +m[1]);
  if (!/SUMIFS/i.test(f) || cols[0] !== AMOUNT_COL || !nameCols.includes(cols[1])) return null;
  let k = 0;
  return f.replace(re, (m, c) => {
    const i = k++;
    if (i === 1) return `'${PC_TAB}'!C${nameCol}:C${nameCol}`;
    if (i === 2 && !CHECK_COLS.includes(+c)) return `'${PC_TAB}'!C${itemCol}:C${itemCol}`;
    return m;
  });
}

// ---------- フォーム ----------

function findItem(form, title) {
  const hit = form.getItems().filter(it => it.getType() !== FormApp.ItemType.PAGE_BREAK && it.getTitle().trim() === title);
  if (hit.length !== 1) throw new Error(`質問「${title}」が ${hit.length} 件`);
  return hit[0];
}

function choiceItem(it) {
  return it.getType() === FormApp.ItemType.LIST ? it.asListItem() : it.asMultipleChoiceItem();
}

// 旧構成(予算ごとのセクション約70個)を、区分ごとに 1 セクションの構成に作り替える。
function migrateForm(form) {
  if (form.getId() === PROD_FORM_ID) throw new Error('本番フォームはまだ移行しない');
  const T = FormApp.ItemType;
  const pages = {};
  const del = [];
  let section = null;
  for (const it of form.getItems()) {
    if (it.getType() === T.PAGE_BREAK) {
      section = it.getTitle().trim();
      if (KEEP_SECTIONS.includes(section) && !pages[section]) pages[section] = it.asPageBreakItem();
      else del.push(it);
    } else if (section !== null && !KEEP_SECTIONS.includes(section) && it.getTitle().trim() !== KINDS['ハウス予算'].item) {
      del.push(it);
    }
  }
  const missing = KEEP_SECTIONS.filter(s => !pages[s]);
  if (missing.length) throw new Error('セクションが見つからない: ' + missing.join(', '));
  const kindQ = choiceItem(findItem(form, '予算選択'));
  findItem(form, KINDS['ハウス予算'].item); // 無ければここで止める

  for (const k of Object.values(KINDS)) { // 削除するセクションを指す移動先を先に外す
    const q = choiceItem(findItem(form, k.name));
    q.setChoiceValues(q.getChoices().map(c => c.getValue()));
  }
  const deleted = del.map(it => it.getTitle());
  del.forEach(it => form.deleteItem(it));

  const order = KEEP_SECTIONS.map(s => pages[s].getIndex());
  if (order.some((x, i) => i && x < order[i - 1])) throw new Error('セクションの並びが想定と違う');
  // PageBreakItem の goTo は「直前のセクションを終えたとき」の移動先
  const detail = pages['費用詳細入力'];
  const names = Object.values(KINDS).map(k => pages[k.section]);
  names[0].setGoToPage(FormApp.PageNavigationType.CONTINUE);
  names.slice(1).forEach(p => p.setGoToPage(detail));
  detail.setGoToPage(FormApp.PageNavigationType.CONTINUE);
  kindQ.setChoices(kindQ.getChoices().map(c => {
    const k = KINDS[c.getValue()];
    if (!k) throw new Error('予算選択の想定外の選択肢: ' + c.getValue());
    return kindQ.createChoice(c.getValue(), pages[k.section]);
  }));
  return deleted;
}

// 表示中の予算タブ → フォームの選択肢。期の途中の追加・終了は予算タブの編集(と非表示)だけで反映される。
function syncChoices(form, ss) {
  const uniq = a => [...new Set(a)];
  const detail = form.getItems(FormApp.ItemType.PAGE_BREAK).map(it => it.asPageBreakItem()).find(p => p.getTitle().trim() === '費用詳細入力');
  // 区分の最後の質問は選択肢ごとに 費用詳細入力 へ飛ばす(「次のセクションへ」だと隣の区分に入るため)
  const set = (title, values, last) => {
    const q = choiceItem(findItem(form, title));
    const to = c => c.getPageNavigationType() === FormApp.PageNavigationType.GO_TO_PAGE ? c.getGotoPage().getTitle() : null;
    const old = q.getChoices().map(c => c.getValue());
    added.push(...values.filter(v => !old.includes(v)).map(v => `${title}: + ${v}`));
    added.push(...old.filter(v => !values.includes(v)).map(v => `${title}: - ${v}`));
    const now = JSON.stringify(q.getChoices().map(c => [c.getValue(), to(c)]));
    if (now !== JSON.stringify(values.map(v => [v, last ? detail.getTitle() : null]))) {
      q.setChoices(values.map(v => last ? q.createChoice(v, detail) : q.createChoice(v)));
    }
  };
  const added = [];
  for (const [kind, k] of Object.entries(KINDS)) {
    const rows = [];
    for (const sh of ss.getSheets()) {
      if (sh.isSheetHidden() || !k.tab.test(sh.getName()) || sh.getLastRow() < 1) continue;
      const rg = sh.getRange(1, 1, sh.getLastRow(), Math.min(sh.getLastColumn(), 9));
      rows.push(...budgetRows(rg.getDisplayValues(), rg.getFormulas()));
    }
    if (!rows.length) throw new Error(`${kind} の予算が表示中の予算タブに無い`);
    if (k.item) {
      set(k.name, uniq(rows.map(r => r[0])), false);
      set(k.item, uniq(rows.map(r => r[1])), true);
    } else {
      set(k.name, uniq(rows.map(r => r[0] + SEP + r[1])), true);
    }
  }
  CacheService.getScriptCache().remove('manifest');
  return added;
}

// ---------- 回答シート ----------

// 予算名・予算項目を新旧の回答で同じ形に揃える列をプロセスチェックシートに足し、予算タブの集計式をそこへ向ける。
function migrateSheet(ss) {
  if (ss.getId() === PROD_SHEET_ID) throw new Error('本番シートはまだ移行しない');
  const resp = ss.getSheetByName(RESP_TAB);
  const pc = ss.getSheetByName(PC_TAB);
  const head = resp.getRange(1, 1, 1, resp.getLastColumn()).getValues()[0].map(s => String(s).trim());
  const col = t => { const i = head.indexOf(t); if (i < 0) throw new Error('回答列が無い: ' + t); return i + 1; };
  const [kind, house, houseItem, iin, club, mypro] = ['予算選択', 'ハウス名', 'ハウス予算項目', '委員会名選択', 'クラブ名選択', 'マイプロジェクト選択'].map(col);

  const nameCol = pc.getLastColumn() + 1;
  const itemCol = nameCol + 1;
  if (pc.getMaxColumns() < itemCol) pc.insertColumnsAfter(pc.getMaxColumns(), itemCol - pc.getMaxColumns());
  if (pc.getMaxRows() < 4601) pc.insertRowsAfter(pc.getMaxRows(), 4601 - pc.getMaxRows());
  if (pc.getRange(3, nameCol).getValue() !== '') throw new Error('集計用の列が空いていない');
  const last = resp.getRange(1, resp.getLastColumn()).getA1Notation().replace(/\d+/, '');
  // プロセスチェックシートの 4 行目 = 回答の 3 行目(A4 の IMPORTRANGE と同じずれ)
  const R = `'${RESP_TAB}'!A3:${last}4600`;
  const s = `INDEX(r,1,${iin})&INDEX(r,1,${club})&INDEX(r,1,${mypro})`;
  pc.getRange(3, nameCol, 1, 2).setValues([['予算名(集計用)', '予算項目(集計用)']]);
  pc.getRange(4, nameCol).setFormula(
    `=BYROW(${R},LAMBDA(r,LET(k,INDEX(r,1,${kind}),s,${s},IF(k="","",IF(k="ハウス予算",INDEX(r,1,${house}),IFERROR(REGEXEXTRACT(s,"^[^${SEP}]*"),""))))))`);
  // 旧回答の予算項目は、予算ごとの項目列のどれか 1 つに入っている
  pc.getRange(4, itemCol).setFormula(
    `=BYROW(${R},LAMBDA(r,LET(k,INDEX(r,1,${kind}),s,${s},c,SEQUENCE(1,COLUMNS(r)),IF(k="","",IF(k="ハウス予算",INDEX(r,1,${houseItem}),` +
    `IF(REGEXMATCH(s,"${SEP}"),REGEXEXTRACT(s,"${SEP}(.*)$"),IFERROR(TEXTJOIN("",TRUE,FILTER(r,(c>${iin})*(c<>${club})*(c<>${mypro}))),"")))))))`);

  const nameCols = [house, iin, club, mypro];
  const skipped = [];
  let changed = 0;
  for (const sh of budgetTabs(ss)) {
    sh.getDataRange().getFormulasR1C1().forEach((row, i) => row.forEach((f, j) => {
      if (!f.includes(PC_TAB)) return;
      const g = rewriteSumifs(f, nameCols, nameCol, itemCol);
      if (g === null) skipped.push(`${sh.getName()}!${sh.getRange(i + 1, j + 1).getA1Notation()}: ${f}`);
      else if (g !== f) { sh.getRange(i + 1, j + 1).setFormulaR1C1(g); changed++; }
    }));
  }
  return { nameCol, itemCol, changed, skipped };
}

function budgetTabs(ss) {
  return ss.getSheets().filter(sh => !sh.isSheetHidden() && Object.values(KINDS).some(k => k.tab.test(sh.getName())));
}

function snapshot(ss) {
  SpreadsheetApp.flush();
  return Object.fromEntries(budgetTabs(ss).map(sh => [sh.getName(), sh.getDataRange().getDisplayValues()]));
}

function diff(a, b) {
  const out = [];
  for (const name in a) a[name].forEach((row, i) => row.forEach((v, j) => {
    const w = (b[name] && b[name][i] || [])[j];
    if (v !== w) out.push(`${name}!R${i + 1}C${j + 1}: ${v} → ${w}`);
  }));
  return out;
}

// ---------- manifest(AI 向け) ----------

function entryId(form, it) {
  const T = FormApp.ItemType;
  const t = it.getType();
  let r;
  if (t === T.TEXT) r = it.asTextItem().createResponse('1');
  else if (t === T.PARAGRAPH_TEXT) r = it.asParagraphTextItem().createResponse('1');
  else if (t === T.DATE) r = it.asDateItem().createResponse(new Date());
  else if (t === T.MULTIPLE_CHOICE || t === T.LIST) { const q = choiceItem(it); r = q.createResponse(q.getChoices()[0].getValue()); }
  else if (t === T.CHECKBOX) { const q = it.asCheckboxItem(); r = q.createResponse([q.getChoices()[0].getValue()]); }
  else return null;
  return form.createResponse().withItemResponse(r).toPrefilledUrl().match(/entry\.(\d+)/)[1];
}

function navTo(type, page) {
  const N = FormApp.PageNavigationType;
  if (type === N.GO_TO_PAGE && page) return page.getTitle();
  if (type === N.SUBMIT) return '送信';
  return null;
}

function toMarkdown(form) {
  const T = FormApp.ItemType;
  const kinds = { TEXT: '記述', PARAGRAPH_TEXT: '記述', DATE: '日付 YYYY-MM-DD', MULTIPLE_CHOICE: '単一選択', LIST: 'プルダウン', CHECKBOX: '複数選択(同じ entry を繰り返す)' };
  const lines = [`# ${form.getTitle()}`, '', `prefill URL: \`${form.getPublishedUrl()}?usp=pp_url\` に \`&entry.<ID>=<値>\` を足す(値は URL エンコード)。`, '', '## (1ページ目)'];
  for (const it of form.getItems()) {
    const t = it.getType();
    const title = it.getTitle().replace(/\s+/g, ' ').trim();
    if (t === T.PAGE_BREAK) {
      const pb = it.asPageBreakItem();
      const to = navTo(pb.getPageNavigationType(), pb.getGoToPage());
      if (to) lines.push(`(このセクションを終えたら → ${to})`);
      lines.push('', `## ${title}`);
      continue;
    }
    if (t === T.FILE_UPLOAD) { lines.push(`- ${title} 必須・ファイル(prefill 不可・ブラウザで添付)`); continue; }
    if (!kinds[t]) continue; // 見出し・画像など
    const q = it[{ TEXT: 'asTextItem', PARAGRAPH_TEXT: 'asParagraphTextItem', DATE: 'asDateItem', MULTIPLE_CHOICE: 'asMultipleChoiceItem', LIST: 'asListItem', CHECKBOX: 'asCheckboxItem' }[t]]();
    const id = entryId(form, it);
    lines.push(`- ${title} \`entry.${id}\` ${q.isRequired() ? '必須' : '任意'}・${kinds[t]}`);
    if (it.getHelpText()) lines.push(`  - 説明: ${it.getHelpText().replace(/\s+/g, ' ')}`);
    if (!q.getChoices) continue;
    for (const c of q.getChoices()) {
      const to = t === T.CHECKBOX ? null : navTo(c.getPageNavigationType(), c.getGotoPage());
      lines.push(`  - ${c.getValue()}${to ? ` → ${to}` : ''}`);
    }
    if (q.hasOtherOption && q.hasOtherOption()) lines.push(`  - その他(自由記述: \`entry.${id}=__other_option__&entry.${id}.other_option_response=<値>\`)`);
  }
  return lines.join('\n') + '\n';
}

function doGet(e) {
  const p = PropertiesService.getScriptProperties().getProperties();
  if (!p.TOKEN || e.parameter.token !== p.TOKEN) return ContentService.createTextOutput('forbidden');
  const cache = CacheService.getScriptCache();
  let md = cache.get('manifest');
  if (!md) { md = toMarkdown(FormApp.openById(p.FORM_ID)); cache.put('manifest', md, 300); }
  return ContentService.createTextOutput(md);
}

// ---------- エディタから実行する手順 ----------

function props() { return PropertiesService.getScriptProperties(); }

// 定期同期(manifest が向くフォームと、その予算タブ)
function sync() {
  const p = props().getProperties();
  syncChoices(FormApp.openById(p.FORM_ID), SpreadsheetApp.openById(p.SHEET_ID));
}

// 手順1: 本番フォームのコピーを新構成にし、選択肢を本番の予算タブから入れる(本番は読むだけ)。回答先は無し。
function step1_createTestForm() {
  const file = DriveApp.getFileById(PROD_FORM_ID).makeCopy('[TEST] 経費申請フォーム(新構成)');
  const form = FormApp.openById(file.getId());
  try { form.removeDestination(); } catch (_) { /* 回答先なし */ }
  const deleted = migrateForm(form);
  const choiceChanges = syncChoices(form, SpreadsheetApp.openById(PROD_SHEET_ID));
  const p = props();
  if (!p.getProperty('TOKEN')) p.setProperty('TOKEN', Utilities.getUuid());
  p.setProperties({ FORM_ID: form.getId(), SHEET_ID: PROD_SHEET_ID, TEST_FORM_ID: form.getId() });
  console.log(JSON.stringify({ edit: form.getEditUrl(), view: form.getPublishedUrl(), deleted: deleted.length, choiceChanges }, null, 1));
}

// 手順2: 本番シートのコピー(リンクされたフォームも複製される)で移行し、既存の集計値が変わらないことを確かめる。
function step2_migrateCopy() {
  const copy = SpreadsheetApp.openById(DriveApp.getFileById(PROD_SHEET_ID).makeCopy('[TEST] 予実管理シート(移行検証)').getId());
  const url = copy.getSheetByName(RESP_TAB).getFormUrl();
  if (!url || url.includes(PROD_FORM_ID)) throw new Error('コピーにフォームの複製が付いていない: ' + url);
  const form = FormApp.openByUrl(url);
  const resp = copy.getSheetByName(RESP_TAB);
  resp.getRange(2, 4, resp.getLastRow() - 1, 4).clearContent(); // 検証に不要な口座情報(D:G)は消す
  // シートの複製で、リンクされた他のフォーム(2022年下期)も複製される。後で消すために控える
  const others = copy.getSheets().map(s => s.getFormUrl()).filter(u => u && u !== url).map(u => FormApp.openByUrl(u).getId());
  props().setProperties({ COPY_SHEET_ID: copy.getId(), COPY_FORM_ID: form.getId(), COPY_OTHER_FORMS: others.join(',') });
  form.setAcceptingResponses(true);
  // コピーの IMPORTRANGE は本番シートを読むので、同じ範囲の直接参照に置き換える
  const pc = copy.getSheetByName(PC_TAB);
  for (const a1 of ['A3', 'A4']) {
    const r = pc.getRange(a1);
    const m = r.getFormula().match(/IMPORTRANGE\("[^"]*","([^"]+)"\)/);
    if (!m) throw new Error(`${PC_TAB}!${a1} が想定外: ${r.getFormula()}`);
    r.setFormula(`=ARRAYFORMULA('${RESP_TAB}'!${m[1].split('!')[1]})`);
  }

  const before = snapshot(copy);
  const deleted = migrateForm(form);
  const sheet = migrateSheet(copy);
  syncChoices(form, copy);
  const after = snapshot(copy);
  const changes = diff(before, after);
  console.log(JSON.stringify({ sheet: copy.getUrl(), form: form.getEditUrl(), deleted: deleted.length, ...sheet, changedValues: changes.length, changes: changes.slice(0, 50) }, null, 1));
}

// 手順3: 移行したコピーのフォームへ区分ごとに 1 件ずつテスト回答し、集計に乗るかを見る(結果は step4)。
function step3_submitTests() {
  const p = props().getProperties();
  const form = FormApp.openById(p.COPY_FORM_ID);
  const ss = SpreadsheetApp.openById(p.COPY_SHEET_ID);
  const answer = (title, v) => {
    const it = findItem(form, title);
    const T = FormApp.ItemType;
    if (it.getType() === T.TEXT) return it.asTextItem().createResponse(String(v));
    if (it.getType() === T.DATE) return it.asDateItem().createResponse(v);
    return choiceItem(it).createResponse(v);
  };
  const first = title => choiceItem(findItem(form, title)).getChoices()[0].getValue();
  const noReceipt = choiceItem(findItem(form, 'レシート写真の必要性')).getChoices()
    .find(c => c.getPageNavigationType() === FormApp.PageNavigationType.SUBMIT).getValue();
  const tests = [];
  Object.entries(KINDS).forEach(([kind, k], n) => {
    const name = first(k.name);
    const [budget, item] = k.item ? [name, first(k.item)] : name.split(SEP);
    const amount = 90001 + n;
    const r = form.createResponse()
      .withItemResponse(answer('返金銀行口座登録', choiceItem(findItem(form, '返金銀行口座登録')).getChoices()[0].getValue()))
      .withItemResponse(answer('予算選択', kind))
      .withItemResponse(answer(k.name, name));
    if (k.item) r.withItemResponse(answer(k.item, item));
    r.withItemResponse(answer('氏名(苗字+名前)', 'テスト')).withItemResponse(answer('購入日付', new Date()))
      .withItemResponse(answer('勘定科目', first('勘定科目'))).withItemResponse(answer('消費税率', first('消費税率')))
      .withItemResponse(answer('購入先', 'テスト')).withItemResponse(answer('購入物品名', 'テスト'))
      .withItemResponse(answer('購入目的', 'テスト')).withItemResponse(answer('経費精算金額(数字のみ入力)(一部金額の精算はできません！！)', amount))
      .withItemResponse(answer('レシート写真の必要性', noReceipt))
      .submit();
    tests.push({ kind, budget, item, amount, before: appliedAmount(ss, kind, budget, item) });
  });
  props().setProperty('TESTS', JSON.stringify(tests));
  console.log(JSON.stringify(tests, null, 1));
}

function step4_verifyTests() {
  const p = props().getProperties();
  const ss = SpreadsheetApp.openById(p.COPY_SHEET_ID);
  SpreadsheetApp.flush();
  const res = JSON.parse(p.TESTS).map(t => {
    const after = appliedAmount(ss, t.kind, t.budget, t.item);
    return { ...t, after, ok: after - t.before === t.amount };
  });
  console.log(JSON.stringify(res, null, 1));
}

// 予算タブで予算名・項目が一致する行の「経費申請額」(行内で最初の集計式のセル)
function appliedAmount(ss, kind, budget, item) {
  for (const sh of budgetTabs(ss).filter(s => KINDS[kind].tab.test(s.getName()))) {
    const rg = sh.getRange(1, 1, sh.getLastRow(), Math.min(sh.getLastColumn(), 9));
    const v = rg.getDisplayValues(), f = rg.getFormulas(), raw = rg.getValues();
    let title = '';
    for (let i = 0; i < v.length; i++) {
      if (v[i + 1] && v[i + 1][1] === '予算項目') title = v[i][1];
      const j = f[i].findIndex(x => x.includes(PC_TAB));
      if (j >= 0 && (v[i][0] || title) === budget && v[i][1] === item) return Number(raw[i][j]);
    }
  }
  throw new Error(`予算タブに行が無い: ${budget} / ${item}`);
}

// 検証で作ったファイルを削除する
function cleanup() {
  const p = props().getProperties();
  const ids = [p.TEST_FORM_ID, p.COPY_FORM_ID, p.COPY_SHEET_ID, ...(p.COPY_OTHER_FORMS || '').split(',')].filter(Boolean);
  for (const id of ids) DriveApp.getFileById(id).setTrashed(true);
}
