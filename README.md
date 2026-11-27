# fast-receipt

経費申請 Google フォームを、レシート画像・Slack の文脈・最小限の質問で埋めるための手順書(`skill/`)。モデルは毎回 Slack キャンバス(フォームの今の質問・entry ID・選択肢・分岐先。GAS が自動更新)を読んで prefill URL を組み立て、ブラウザでレシートを添付する。送信はユーザーの確認後。

- `skill/SKILL.md`: 手順(キャンバスのリンク入り。トークンは含まない)
- `gas/`: 予算タブ → フォームの選択肢の自動同期(予算タブを編集すると走る)と、manifest を返す Web アプリ。本番の移行手順は `docs/migration.md`

## 使い方

- **Claude Desktop**: `skill/` を zip にして Settings → Capabilities → Skills からアップロードする。
- **ChatGPT**: Project を作り、`SKILL.md` の本文を Project の指示に貼る。

ブラウザ操作(Claude in Chrome / ChatGPT agent など)があれば添付まで任せられる。なければ URL を開いて自分で添付する。

## 予算やフォームを変えたとき

- 予算の追加・終了: 予算タブを編集するだけ。フォームと manifest に数秒で反映される(`docs/migration.md`)。
- 質問の変更: フォームを直接編集するだけでよい。manifest は最大 5 分のキャッシュの後に新しい構成を返す。Skill の差し替えは不要。

Node 24 以上が必要(依存パッケージなし)。テストは `npm test`。
