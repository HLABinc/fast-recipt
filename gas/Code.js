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

// onChange のうち sync が要るもの: 予算タブのセル編集と、行の挿入・削除・タブの非表示など。書式変更と他のタブの編集(承認など)は飛ばす
function shouldSync(changeType, sheetName) {
  if (changeType === 'FORMAT') return false;
  if (changeType !== 'EDIT') return true;
  return Object.values(KINDS).some(k => k.tab.test(sheetName));
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
  guardProd(form.getId());
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
  guardProd(ss.getId());
  const pc = ss.getSheetByName(PC_TAB);
  const nameCol = pc.getLastColumn() + 1;
  const itemCol = nameCol + 1;
  if (pc.getMaxColumns() < itemCol) pc.insertColumnsAfter(pc.getMaxColumns(), itemCol - pc.getMaxColumns());
  if (pc.getMaxRows() < 4601) pc.insertRowsAfter(pc.getMaxRows(), 4601 - pc.getMaxRows());
  if (pc.getRange(3, nameCol).getValue() !== '') throw new Error('集計用の列が空いていない');
  const nameCols = unfiltered(pc, () => writeAggFormulas(ss, nameCol));
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

// 集計用 2 列(nameCol, nameCol+1)の式。新旧の回答を同じ予算名・項目に揃える。返り値は旧回答の予算名列
function writeAggFormulas(ss, nameCol) {
  guardProd(ss.getId());
  const resp = ss.getSheetByName(RESP_TAB);
  const pc = ss.getSheetByName(PC_TAB);
  const head = resp.getRange(1, 1, 1, resp.getLastColumn()).getValues()[0].map(s => String(s).trim());
  const col = t => { const i = head.indexOf(t); if (i < 0) throw new Error('回答列が無い: ' + t); return i + 1; };
  const [kind, house, houseItem, iin, club, mypro] = ['予算選択', 'ハウス名', 'ハウス予算項目', '委員会名選択', 'クラブ名選択', 'マイプロジェクト選択'].map(col);

  const itemCol = nameCol + 1;
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
  return [house, iin, club, mypro];
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

function log(s) { console.log(s); }

function props() { return PropertiesService.getScriptProperties(); }

// 定期同期(manifest が向くフォームと、その予算タブ)
function sync() {
  const p = props().getProperties();
  log(JSON.stringify(syncChoices(FormApp.openById(p.FORM_ID), SpreadsheetApp.openById(p.SHEET_ID))));
}

// 予算タブを編集したら自動で sync する(migrateProduction が installSyncTrigger で設定)
function onBudgetChange(e) {
  if (!shouldSync(e.changeType, e.source.getActiveSheet().getName())) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // 続けて編集されても 1 本ずつ。後の実行が最新の予算タブを読む
  try { sync(); } finally { lock.releaseLock(); }
}

function installSyncTrigger() {
  const ss = SpreadsheetApp.openById(props().getProperty('SHEET_ID'));
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'onBudgetChange').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onBudgetChange').forSpreadsheet(ss).onChange().create();
}

// 手順1: 本番フォームのコピーを新構成にし、選択肢を本番の予算タブから入れる(本番は読むだけ)。回答先は無し。
function step1_createTestForm() {
  const file = DriveApp.getFileById(PROD_FORM_ID).makeCopy('[TEST] 経費申請フォーム(新構成)', DriveApp.getRootFolder());
  const form = FormApp.openById(file.getId());
  try { form.removeDestination(); } catch (_) { /* 回答先なし */ }
  form.setPublished(true); // コピーは未公開・受付停止で作られる
  form.setAcceptingResponses(true);
  const deleted = migrateForm(form);
  const choiceChanges = syncChoices(form, SpreadsheetApp.openById(PROD_SHEET_ID));
  const p = props();
  if (!p.getProperty('TOKEN')) p.setProperty('TOKEN', Utilities.getUuid());
  p.setProperties({ FORM_ID: form.getId(), SHEET_ID: PROD_SHEET_ID, TEST_FORM_ID: form.getId() });
  log(JSON.stringify({ edit: form.getEditUrl(), view: form.getPublishedUrl(), deleted: deleted.length, choiceChanges }, null, 1));
}

// 移行の本体(step2 のコピーと本番で共通)。既存の集計値と承認・払い戻しの行が変わらないことも返す
function migrate(form, ss) {
  const before = snapshot(ss), align = alignState(ss);
  const deleted = migrateForm(form);
  const sheet = migrateSheet(ss);
  syncChoices(form, ss);
  const changes = diff(before, snapshot(ss));
  const now = alignState(ss);
  const alignMoved = align.filter((r, i) => JSON.stringify(r) !== JSON.stringify(now[i])).length;
  return { deleted: deleted.length, ...sheet, changedValues: changes.length, changes: changes.slice(0, 50), alignMoved };
}

// 本番移行(docs/migration.md)。スクリプトプロパティ ALLOW_PROD=yes のときだけ動き、終わったら消す
function migrateProduction() {
  const form = FormApp.openById(PROD_FORM_ID);
  form.setAcceptingResponses(false); // 途中の構成で回答が来ないように
  try {
    const res = migrate(form, SpreadsheetApp.openById(PROD_SHEET_ID));
    props().setProperties({ FORM_ID: PROD_FORM_ID, SHEET_ID: PROD_SHEET_ID });
    installSyncTrigger();
    CacheService.getScriptCache().remove('manifest');
    log(JSON.stringify(res, null, 1));
  } finally {
    props().deleteProperty('ALLOW_PROD');
    form.setAcceptingResponses(true);
  }
}

function guardProd(id) {
  if ((id === PROD_FORM_ID || id === PROD_SHEET_ID) && props().getProperty('ALLOW_PROD') !== 'yes') throw new Error('本番は ALLOW_PROD=yes のときだけ移行する');
}

// 手順2: 本番シートのコピー(リンクされたフォームも複製される)で移行し、既存の集計値が変わらないことを確かめる。
function step2_migrateCopy() {
  const copy = SpreadsheetApp.openById(DriveApp.getFileById(PROD_SHEET_ID).makeCopy('[TEST] 予実管理シート(移行検証)', DriveApp.getRootFolder()).getId());
  const url = copy.getSheetByName(RESP_TAB).getFormUrl();
  if (!url || url.includes(PROD_FORM_ID)) throw new Error('コピーにフォームの複製が付いていない: ' + url);
  const form = FormApp.openByUrl(url);
  const resp = copy.getSheetByName(RESP_TAB);
  resp.getRange(2, 4, resp.getLastRow() - 1, 4).clearContent(); // 検証に不要な口座情報(D:G)は消す
  // シートの複製で、リンクされた他のフォーム(2022年下期)も複製される。後で消すために控える
  const others = copy.getSheets().map(s => s.getFormUrl()).filter(u => u && u !== url).map(u => FormApp.openByUrl(u).getId());
  props().setProperties({ COPY_SHEET_ID: copy.getId(), COPY_FORM_ID: form.getId(), COPY_OTHER_FORMS: others.join(',') });
  form.setPublished(true);
  stripUpload(form); // 共有ドライブにできたコピーは、アップロード質問があると回答を受け付けない
  unfiltered(copy.getSheetByName(PC_TAB), () => localizeImports(copy));

  log(JSON.stringify({ sheet: copy.getUrl(), form: form.getEditUrl(), ...migrate(form, copy) }, null, 1));
}

// 手順3: 区分ごとに 1 件ずつ、送信前の集計額とテスト回答の prefill URL を作る(ブラウザで送信 → step4)。
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
    const before = appliedAmount(ss, kind, budget, item); // 送信前に取る
    const r = form.createResponse();
    const qa = [['返金銀行口座登録', first('返金銀行口座登録')], ['予算選択', kind], [k.name, name], ...(k.item ? [[k.item, item]] : []),
      ['氏名(苗字+名前)', 'テスト'], ['購入日付', new Date()], ['勘定科目', first('勘定科目')], ['消費税率', first('消費税率')],
      ['購入先', 'テスト'], ['購入物品名', 'テスト'], ['購入目的', 'テスト'],
      ['経費精算金額(数字のみ入力)(一部金額の精算はできません！！)', amount], ['レシート写真の必要性', noReceipt]];
    // どの回答が弾かれたか分かるように 1 つずつ足す
    for (const [t, v] of qa) { try { r.withItemResponse(answer(t, v)); } catch (e) { throw new Error(`${kind} / ${t}: ${e.message}`); } }
    // FormResponse.submit() はシートのコピーに付いたフォームでは失敗する。Skill と同じく prefill URL をブラウザで送信する
    tests.push({ kind, budget, item, amount, before, url: r.toPrefilledUrl() });
  });
  props().setProperty('TESTS', JSON.stringify(tests));
  log(JSON.stringify(tests, null, 1));
}

function step4_verifyTests() {
  const p = props().getProperties();
  const ss = SpreadsheetApp.openById(p.COPY_SHEET_ID);
  SpreadsheetApp.flush();
  const res = JSON.parse(p.TESTS).map(t => {
    const after = appliedAmount(ss, t.kind, t.budget, t.item);
    return { ...t, after, ok: after - t.before === t.amount };
  });
  log(JSON.stringify(res, null, 1));
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

// 検証で作ったファイルをゴミ箱へ(本番 ID は触らない)。テストで添付した画像と、テストフォームの回答フォルダも
function cleanup() {
  const p = props().getProperties();
  const ids = [p.TEST_FORM_ID, p.COPY_FORM_ID, p.COPY_SHEET_ID, ...(p.COPY_OTHER_FORMS || '').split(',')].filter(Boolean);
  const files = [], folders = [];
  for (const it = DriveApp.searchFiles("title = 'test-receipt.png' and 'me' in owners"); it.hasNext();) files.push(it.next());
  for (const it = DriveApp.searchFolders("title contains '[TEST] 経費申請フォーム' and 'me' in owners"); it.hasNext();) folders.push(it.next());
  const out = [];
  for (const id of ids) {
    if (id === PROD_FORM_ID || id === PROD_SHEET_ID) throw new Error('本番');
    try { const f = DriveApp.getFileById(id); f.setTrashed(true); out.push(`${f.getName()}: trashed`); } catch (e) { out.push(`${id}: ${e.message}`); }
  }
  for (const f of [...files, ...folders]) { try { f.setTrashed(true); out.push(`${f.getName()}: trashed`); } catch (e) { out.push(`${f.getName()}: ${e.message}`); } }
  props().deleteProperty('TESTS'); props().deleteProperty('TESTS2'); props().deleteProperty('ALIGN_BASE');
  log(out.join('\n'));
}

// Skill に渡す URL と、いま返す manifest をログに出す
function info() {
  const p = props().getProperties();
  log(`manifest URL: ${ScriptApp.getService().getUrl()}?token=${p.TOKEN}`);
  log(toMarkdown(FormApp.openById(p.FORM_ID)));
}

// コピーの IMPORTRANGE は本番シートを読むので、同じ範囲の直接参照に置き換える(置き換え済みは飛ばす)
function localizeImports(copy) {
  if (copy.getId() === PROD_SHEET_ID) throw new Error('本番シートは触らない');
  const pc = copy.getSheetByName(PC_TAB);
  for (const a1 of ['A3', 'A4']) {
    const r = pc.getRange(a1);
    if (r.getFormula().startsWith(`=ARRAYFORMULA('${RESP_TAB}'!`)) continue;
    const m = r.getFormula().match(/IMPORTRANGE\("[^"]*","([^"]+)"\)/);
    if (!m) throw new Error(`${PC_TAB}!${a1} が想定外: ${r.getFormula()}`);
    r.setFormula(`=ARRAYFORMULA('${RESP_TAB}'!${m[1].split('!')[1]})`);
  }
}

// フィルタで隠れた行への setFormula はエラーなしで無視される(値は入る)。条件を一時的に外して書き、元に戻す
function unfiltered(sh, fn) {
  const fl = sh.getFilter();
  if (!fl) return fn();
  const r = fl.getRange(), saved = [];
  for (let c = r.getColumn(); c <= r.getLastColumn(); c++) {
    const cr = fl.getColumnFilterCriteria(c);
    if (cr) { saved.push([c, cr]); fl.removeColumnFilterCriteria(c); }
  }
  try { return fn(); } finally { saved.forEach(([c, cr]) => fl.setColumnFilterCriteria(c, cr)); }
}

// 共有ドライブのフォームはファイルアップロード質問があると回答を受け付けない(submit() も Invalid data updating form)。
// コピーのフォームからだけ外す。添付の経路はアップロード質問付きのテストフォーム(マイドライブ)で確かめる
function stripUpload(form) {
  if (form.getId() === PROD_FORM_ID) throw new Error('本番');
  form.getItems(FormApp.ItemType.FILE_UPLOAD).forEach(it => form.deleteItem(it));
  form.setAcceptingResponses(true);
}

// 手順5: 期の途中の選択肢追加(委員会タブに 1 行足して sync)と、口座未登録の分岐。送信はブラウザで prefill URL から行う。
function step5_prepare() {
  const p = props().getProperties();
  if (p.COPY_SHEET_ID === PROD_SHEET_ID || p.COPY_FORM_ID === PROD_FORM_ID) throw new Error('本番');
  const form = FormApp.openById(p.COPY_FORM_ID);
  const ss = SpreadsheetApp.openById(p.COPY_SHEET_ID);
  const NEW = ['26年度後期テスト追加委員会', '活動支援金'];
  const sh = budgetTabs(ss).find(s => KINDS['委員会予算'].tab.test(s.getName()));
  const rg = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn());
  const v = rg.getDisplayValues(), f = rg.getFormulas();
  if (!v.some(r => r[0] === NEW[0])) {
    const i = v.findIndex((r, k) => r[0] && r[1] && f[k].some(x => x.includes(PC_TAB))); // 最初の委員会の行
    sh.insertRowAfter(i + 1);
    sh.getRange(i + 1, 1, 1, sh.getLastColumn()).copyTo(sh.getRange(i + 2, 1, 1, sh.getLastColumn()));
    sh.getRange(i + 2, 1, 1, 2).setValues([NEW]);
  }
  const changes = syncChoices(form, ss);
  const label = NEW.join(SEP);
  const inManifest = toMarkdown(form).includes(label);
  const first = t => choiceItem(findItem(form, t)).getChoices()[0].getValue();
  const resp = (t, val) => {
    const it = findItem(form, t), T = FormApp.ItemType;
    if (it.getType() === T.TEXT) return it.asTextItem().createResponse(String(val));
    if (it.getType() === T.DATE) return it.asDateItem().createResponse(val);
    return choiceItem(it).createResponse(val);
  };
  const noReceipt = choiceItem(findItem(form, 'レシート写真の必要性')).getChoices()
    .find(c => c.getPageNavigationType() === FormApp.PageNavigationType.SUBMIT).getValue();
  const acct = choiceItem(findItem(form, '返金銀行口座登録')).getChoices().map(c => c.getValue());
  const cases = [
    { name: 'midterm', account: acct[0], budget: NEW[0], item: NEW[1], amount: 90005 },
    { name: 'newAccount', account: acct.find(a => a.includes('ない')), budget: '26年度後期College Incubator Capital', item: '活動支援金', amount: 90006 },
  ];
  const tests = cases.map(c => {
    const qa = [['返金銀行口座登録', c.account], ['予算選択', '委員会予算'], ['委員会名選択', c.budget + SEP + c.item],
      ['氏名(苗字+名前)', 'テスト'], ['購入日付', new Date()], ['勘定科目', first('勘定科目')], ['消費税率', first('消費税率')],
      ['購入先', 'テスト'], ['購入物品名', 'テスト'], ['購入目的', 'テスト'],
      ['経費精算金額(数字のみ入力)(一部金額の精算はできません！！)', c.amount], ['レシート写真の必要性', noReceipt]];
    if (c.name === 'newAccount') qa.push(['銀行名', 'テスト銀行'], ['支店名', 'テスト支店'], ['口座番号(半角)', '0000000'], ['口座名義(カタカナ)', 'テスト']);
    const r = form.createResponse();
    qa.forEach(([t, val]) => r.withItemResponse(resp(t, val)));
    return { kind: '委員会予算', budget: c.budget, item: c.item, amount: c.amount, name: c.name, before: appliedAmount(ss, '委員会予算', c.budget, c.item), url: r.toPrefilledUrl() };
  });
  props().setProperty('TESTS2', JSON.stringify(tests));
  props().setProperty('ALIGN_BASE', JSON.stringify(alignState(ss)));
  log(JSON.stringify({ changes, inManifest, tests }, null, 1));
}

// 承認(CJ)・払い戻し(CK)が同じ回答の行に付いたままか: プロセスチェックシートの行ごとの [タイムスタンプ, CJ, CK]
function alignState(ss) {
  const pc = ss.getSheetByName(PC_TAB);
  const n = pc.getLastRow() - 3;
  const a = pc.getRange(4, 1, n, 1).getValues(), c = pc.getRange(4, CHECK_COLS[0], n, 2).getValues();
  return a.map((r, i) => [r[0] instanceof Date ? r[0].getTime() : String(r[0]), String(c[i][0]), String(c[i][1])]).filter(r => r[0] !== '');
}

// 手順6: step5 の送信結果・口座の分岐・行ずれ・テストフォームへの添付を確かめる(個人情報は出さない: 件数と真偽のみ)
function step6_verify() {
  const p = props().getProperties();
  const ss = SpreadsheetApp.openById(p.COPY_SHEET_ID);
  SpreadsheetApp.flush();
  const tests = JSON.parse(p.TESTS2).map(t => {
    const after = appliedAmount(ss, t.kind, t.budget, t.item);
    return { name: t.name, before: t.before, after, ok: after - t.before === t.amount };
  });
  // 口座未登録の回答には口座 4 項目(D:G)が入り、登録済みの回答には入らない
  const resp = ss.getSheetByName(RESP_TAB);
  const head = resp.getRange(1, 1, 1, resp.getLastColumn()).getValues()[0].map(x => String(x).trim());
  const amtCol = head.findIndex(h => h.startsWith('経費精算金額')) + 1;
  const last = resp.getRange(Math.max(2, resp.getLastRow() - 9), 1, Math.min(10, resp.getLastRow() - 1), resp.getLastColumn()).getValues();
  const acct = amount => { const r = last.find(x => Number(x[amtCol - 1]) === amount); return r ? r.slice(3, 7).every(x => x !== '') : 'row not found'; };
  // 行ずれ: step5 時点の行と今の行を比べる(新しい回答は末尾に足されるだけのはず)
  const base = JSON.parse(p.ALIGN_BASE), now = alignState(ss);
  const moved = base.filter((r, i) => JSON.stringify(r) !== JSON.stringify(now[i])).length;
  // 本番とも比べる(コピー作成時点までの行。本番で後から承認された分は差として出る)
  const prod = alignState(SpreadsheetApp.openById(PROD_SHEET_ID));
  const tsMismatch = base.filter((r, i) => !prod[i] || r[0] !== prod[i][0]).length;
  const checkDiff = base.filter((r, i) => prod[i] && r[0] === prod[i][0] && (r[1] !== prod[i][1] || r[2] !== prod[i][2])).length;
  const newRows = now.slice(base.length).map(r => [r[1], r[2]]);
  // テストフォームへの添付付き送信
  const tf = FormApp.openById(p.TEST_FORM_ID);
  const up = tf.getItems(FormApp.ItemType.FILE_UPLOAD)[0];
  const tr = tf.getResponses();
  const lastUp = tr.length ? tr[tr.length - 1].getResponseForItem(up) : null;
  log(JSON.stringify({
    tests, accountFilled: { newAccount: acct(90006), registered: acct(90005) },
    align: { rows: base.length, nowRows: now.length, movedSinceStep5: moved, timestampMismatchVsProd: tsMismatch, checkDiffVsProd: checkDiff, newRowsChecks: newRows },
    upload: { testFormResponses: tr.length, lastHasFile: !!(lastUp && lastUp.getResponse() && lastUp.getResponse().length) },
  }, null, 1));
}
