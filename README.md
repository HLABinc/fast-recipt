# fast-receipt

経費申請 Google フォームを、レシート画像・Slack の文脈・最小限の質問で埋めるための手順書(`skill/`)。サーバーは持たない。モデルが `skill/form.md` を見て prefill URL を組み立て、ブラウザでレシートを添付する。送信はユーザーの確認後。

- `skill/SKILL.md`: 手順と分岐の読み方(人が書く)
- `skill/form.md`: 質問・entry ID・選択肢・分岐先(フォームから生成)

## 使い方

- **Claude Desktop**: `skill/` を zip にして Settings → Capabilities → Skills からアップロードする。
- **ChatGPT**: Project を作り、`SKILL.md` の本文を Project の指示に貼り、`form.md` をファイルとして追加する。

ブラウザ操作(Claude in Chrome / ChatGPT agent など)があれば添付まで任せられる。なければ URL を開いて自分で添付する。

## 期初の更新(フォームの項目を変えたとき)

フォームの編集権限を持つアカウントで行う。

1. https://developers.google.com/oauthplayground/ で scope `https://www.googleapis.com/auth/forms.body.readonly` を許可し、`https://forms.googleapis.com/v1/forms/<フォームID>` に GET して、結果を `forms-get.json` に保存する(終わったら https://myaccount.google.com/permissions で権限を削除)。
2. `npm run dump-form -- forms-get.json > skill/form.md`
3. `git diff skill/form.md` で変更点を確認する。予算の流れが変わっていたら `SKILL.md` の「分岐の読み方」を直す。
4. コミットして、Skill / Project のファイルを差し替える。

Node 24 以上が必要(依存パッケージなし)。テストは `npm test`。
