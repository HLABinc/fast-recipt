# fast-receipt

経費申請 Google フォームを、レシート画像 + Slack の文脈 + 最小限の質問で埋めて prefill URL を作る MCP サーバー。

- レシートの読み取り・Slack 検索・添付操作はホスト(Claude / ChatGPT)側に任せ、サーバーは「質問項目の提供」と「回答の検証 + URL 生成」だけを行う。
- フォーム構造と予算ツリーは期初(フォームの項目変更時)に同期して `schema/form.json` に保存する。入力時は推定をせず、この定義だけを使う。

## ツール

| ツール | 役割 |
|---|---|
| `get_expense_form` | 共通の質問(表示条件付き)と予算ツリー、入力手順 |
| `build_expense_prefill_url` | 回答を検証して prefill URL・選んだ予算(`budget`)・表示される質問のうち未回答の必須(`missingRequired`)を返す |

URL を開いたあとはホスト側のブラウザ操作(Claude in Chrome / computer use / ChatGPT agent)で次を行う。送信はユーザー確認後。

- 「Continue current draft?」が出たら **Continue**(prefill 側を使う)
- メールアドレス記録のチェックボックスにチェック(prefill 不可)
- アップロードページでレシートを添付(prefill 不可)

## 1. 期初の同期(フォームの項目変更時)

フォームの編集権限を持つアカウントで行う。

### 1-1. forms.get の JSON を取得

**A. OAuth 2.0 Playground(GCP プロジェクト不要)**

1. https://developers.google.com/oauthplayground/ で scope に `https://www.googleapis.com/auth/forms.body.readonly` を入力 → Authorize APIs → 許可 → Exchange authorization code for tokens
2. Step 3 で `https://forms.googleapis.com/v1/forms/<フォームID>` に GET し、レスポンスを `forms-get.json` に保存
3. 終わったら https://myaccount.google.com/permissions から「Google OAuth 2.0 Playground」を削除

**B. アクセストークンを直接渡す**: `GOOGLE_ACCESS_TOKEN=ya29... npm run sync-schema -- --form-id <フォームID>`

### 1-2. 同期設定を確認(`schema/sync-config.json`)

Forms API は選択肢ごとの分岐先は返すが、「セクション○以降:次のセクションに進む」の設定は返さない。そのため予算の範囲と続き方は手で明示する。

```json
{
  "budgetStart": "予算選択",
  "budgetEnd": "費用詳細入力",
  "continue": { "ハウス選択": "ハウス予算項目選択" }
}
```

- `budgetStart` / `budgetEnd`: 予算を選ぶセクション群の最初と、その後に合流するセクション
- `continue`: 選択肢による分岐がなく、そのまま別の予算セクションへ進むもの

予算セクションは「選択式の質問 1 問だけ」である必要がある(違えば同期がエラーで止まる)。

### 1-3. 同期して確認

```sh
npm run sync-schema -- --from forms-get.json
```

次が表示されるので確認し、`schema/form.json` の差分ごとコミットする。

- 前回からの項目・選択肢の差分
- 予算ツリー(予算選択 → 各予算 → 予算項目)
- 表示条件付きのセクション(振込口座登録、レシートのアップロード)
- どの選択肢からも辿れない予算セクション(旧年度のものなど。ツリーから除外される)

## 2. Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "fast-receipt": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/itteam/Projects/fast-recipt/src/stdio.ts"]
    }
  }
}
```

別のフォーム(本番/コピー)を使うときは `"env": { "EXPENSE_FORM_SCHEMA": "/path/to/form.json" }` を足す。

Claude Code / Codex も同じく `node src/stdio.ts` を stdio サーバーとして登録すればよい。

## 3. ChatGPT

ChatGPT のコネクタはリモート(HTTPS)の MCP が必要。

```sh
npm run start:http   # http://localhost:8787/mcp
```

これを cloudflared / ngrok などで HTTPS 公開するか、任意のホスティングにデプロイし、ChatGPT の開発者モードでコネクタとして `https://<host>/mcp` を登録する。サーバーは秘密情報を持たない(schema のみ)が、URL を知っていれば誰でも質問項目を読める点に注意。

## 開発

Node 22.18+ の型ストリップで `.ts` を直接実行する(ビルド不要)。

```sh
npm test
npm run typecheck
```
