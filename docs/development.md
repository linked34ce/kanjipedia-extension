# 開発・データ収集の手順

拡張の開発、事前調査、データ収集・更新、ビルド、検証に関する手順です。拡張の導入・仕様・使い方は [README](../README.md) を参照してください。

調査の観測結果と利用条件の確認状況は [サイト確認記録](site-status.md)、実装・テスト結果と収集範囲は [実装・受入検証](verification.md) に記録しています。コード実装済み、全接頭辞の収集は途中です。公開方針は下記のとおり、ユーザーの判断に基づいてGitHubのみを対象にしています。

GitHub向けの対応表は `data/published/`、その対応表から生成した読み込み用ファイルは `extension/data.js` と `extension/content.js` に保存し、Git管理します。取得HTML、HTTP証跡、収集キュー、ローカルの収集世代はGit対象外です。新しいチェックアウトからも追加収集なしで拡張を読み込めます。実サイト上でのChrome手動確認は未実施です。

## 環境とオフライン検証

Node.js 24系LTSとnpmを使用します。依存バージョンは `package.json` と `package-lock.json` で固定しています。

```powershell
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

テスト自体は外部サイトへアクセスしません。ブラウザのインストールは初回のみダウンロードが必要です。ブラウザテストは合成データを一時フォルダーにビルドして本物のMV3拡張として読み込み、通信を遮断したページで比較します。結果と比較画像は `artifacts/` に出力します。普段のChromeプロファイルは使用しません。

Windows PowerShellでの引数の取り違えを避けるため、引数を付ける収集操作は `node collector/cli.js` で直接実行します。

## 調査と小規模収集

```powershell
node collector/cli.js help
node collector/cli.js survey --group terms
node collector/cli.js survey --group search
node collector/cli.js survey --group kana
node collector/cli.js survey --group article
node collector/cli.js survey --group target
node collector/cli.js collect --prefixes あ --from-survey
```

`terms` はrobots・サイト紹介・メニューと協会の方針、`search` は「あ」の先頭（page省略／明示1）・2・動的に検出した末尾、`kana` は「か／が」「は／ば／ぱ」、`article` は亜と白亜の代表2記事、`target` は「はくあ」の検索です。記事全件を巡回しません。成功した調査はローカルの証跡を再使用します。条件を改めて確認するときは `survey --group terms --refresh` のように指定すると、robotsも含め共通ゲートで再取得します。robotsの通常キャッシュ期限は24時間です。

`collect` は新しいrunを作成しIDを出力します。既定は「あ」、**1回10 HTTP要求まで**です。`--from-survey` は保存済みの調査をこの収集の出典として取り込み、本文ハッシュを検証してから解析します。省略すれば新しく取得します。`--seed-page 2` は先頭が取得できない場合の調査に使えますが、ページ1を取得済みにするものではありません。

中点は一律に分割しません。代表記事と検索結果を照合したうえで異表記として確認できる行だけ、パス・原見出し・原読みが完全一致するレビューを登録できます。

```powershell
node collector/cli.js review-variants --path /kotoba/0005614200 --variants 白亜,白堊
```

これは保存した検索と個別記事の見出し・読み・ハッシュが整合する場合だけ登録できます。中点の意味そのものは確認者が判断する必要があります。他の項目への一般化はしません。レビューは `.local/verified-variants.json` に保存し、新しいrunへコピーします。

## 全接頭辞の収集・再開・更新

run `9f47a2d6-db36-449d-94f5-455490ae081f` のバックグラウンド収集は、2026-11-15 22:06 JSTにUTC日次上限500要求で停止しました。444／468ページを取得し、33,278見出しの部分辞書を検証・ビルド済みです。残りは24ページです。途中データは引き続き `data/partial/` に保存し、完成世代の参照は更新しません。

収集状態は次のコマンドで確認できます。日次枠の切り替えは翌日09:00 JST（00:00 UTC）です。再開時も既存runと保存した日次カウンターを使ってください。自動で翌日再開する設定はしていません。

```powershell
node collector/cli.js report --run 9f47a2d6-db36-449d-94f5-455490ae081f
Get-Content -Raw -Encoding UTF8 .local/collection-job.json
```

`.local/collection-job.json` は収集中／検証中／完了または途中停止の状態を記録します。終了時の集計は `.local/latest-collection-report.json`、検証処理のエラーは `.local/collection-finalizer.stderr.log` に保存します。

```powershell
node collector/cli.js collect --full --from-survey
node collector/cli.js report --run RUN_ID
node collector/cli.js resume --run RUN_ID
node collector/cli.js reparse --run RUN_ID
```

`--full` は `collector/prefixes.js` の86接頭辞を対象にします。濁音・半濁音、ゐ・ゑ・を・ん、小書き、ゔも対象です。除外・清音への包含は仮定していません。`--prefixes はくあ` のような追加範囲も併用できます。ページ数は応答から動的に求めます。未調査の接頭辞は総件数・最終ページとも未確定です。検索接頭辞の完全性と辞典全体の収録範囲は別です。

`--full` でも既定の10要求上限を維持します。必要に応じて `--max-requests 20` のように指定できます（1～500）。UTC日次上限は500要求で、robots、検証、失敗、転送、再試行も数えます。再起動でリセットしません。全工程で同時実行1、応答終了後10秒以上＋0～5秒のジッターを設け、robotsの長い間隔を優先します。検索条件違い・反復ページ・件数変動・ブロックは停止します。

`resume` は同じキューと証跡を使い、成功ページを再取得しません。`reparse` はネットワークなしで保存本文を再解析します。HTML保存が中断しても原子的に保存した応答一式から復元できます。Ctrl+Cでは状態を保存し、進行中の応答処理の終了後に停止します。

429はRetry-After（秒／日時）と最低15分のうち遅い方まで全体を停止し、冷却後も自動再起動しません。401／403／CAPTCHA、robots拒否は即停止します。ネットワーク障害・5xxは最大3試行、待機は60秒、180秒＋ジッターです。連続3失敗後は原因と `.local/http/` の証跡を確認してください。再調査を明示的に始める場合のみ `node collector/cli.js reset-failures` で連続失敗停止を解除できます。冷却時間や日次要求数は解除されません。3試行を使い切ったページの再取得には、新しいrunを作成してください。

更新は新しい `collect` で別世代を作ります。古いrunと辞書を自動混合しません。件数変動を検出したrunも、新しい世代で取り直してください。

終了コードは0=指定範囲の処理成功、1=入出力・設定・スキーマ等のエラー、2=要求上限・中断・未完了、3=アクセス拒否・解析／整合性検証による停止です。`survey` の0は調査保存の成功であり、収集完成を意味しません。

## 辞書の出力・ビルド

```powershell
node collector/cli.js export --run RUN_ID
npm run validate
npm run build
```

指定した検索範囲のページ・件数が整合したrunだけ `data/generations/RUN_ID/` に出力し、検証後に `data/current.json` の参照を更新します。この操作はローカルファイルへの出力であり、公開・アップロードではありません。`complete: true` はそのrunの検索範囲についてのみ成立します。解析保留行があれば辞書はその分を含みません。

途中データは明示的に別の場所へ出力・ビルドします。完成世代の参照を更新しません。

```powershell
node collector/cli.js export --run RUN_ID --partial
node collector/cli.js validate --input data/partial/RUN_ID/dictionary.json
node collector/cli.js build --input data/partial/RUN_ID/dictionary.json
```

辞書は語→候補配列です。同形異読と同じ読みの別URLを保持し、確定できなければリンクを作りません。JSON Schema、URL形式、辞書とmanifestのSHA-256を検証します。本文は時刻を含まず安定順で出力し、収集期間・範囲・不足・衝突・解析保留は別manifestに保存します。生成JSはJSON.parseと安全なシリアライズを使い、evalや外部HTML挿入を使いません。

今回使った部分データの再ビルドと、保存した実HTMLでの再検証は次のとおりです。

```powershell
node collector/cli.js build --input data/partial/9f47a2d6-db36-449d-94f5-455490ae081f/dictionary.json
node scripts/verify-local.js data/partial/9f47a2d6-db36-449d-94f5-455490ae081f/dictionary.json
node tests/browser.js --input data/partial/9f47a2d6-db36-449d-94f5-455490ae081f/dictionary.json --html .local/acceptance.html
```

通常の `npm run build` と `npm run validate` は、同梱した `data/published/dictionary.json` を使います。このファイルがまだない開発環境では、`data/current.json` が指す完成世代を使います。個別の収集世代を試す場合は上記の明示指定を使ってください。

## ローカルデータの削除

収集プロセスが終了したことを確認してから、対象runの `.local/runs/RUN_ID/` と対応する `data/partial/RUN_ID/` または `data/generations/RUN_ID/` をエクスプローラーで削除します。完成世代が `data/current.json` の参照先なら、この参照も削除または別の完成世代へ更新してください。

調査本文は `.local/survey/`、HTTP証跡は `.local/http/`、中点レビューは `.local/verified-variants.json`、テスト画像等は `artifacts/` にあります。生成済み辞書も削除する場合は `extension/data.js` と `extension/content.js` を削除し、Chromeから拡張を削除します。**日次上限・冷却時間の維持のため、収集を続ける間は `.local/gate.json` を削除しないでください。** プロセスロックは通常自動解放され、異常終了したPIDのロックも次回起動で回復します。

公開用ファイルに取得HTMLや収集キューを混入させないでください。今後も機能・修正・データ更新などの適切な作業単位で検証してコミットします。

## GitHub向けの公開データと配布

2026-11-15のユーザー判断に基づき、言葉の表記・読み・URLの対応表を公開対象にします。配布先はGitHubのみとし、Chromeウェブストアへの公開・申請は行いません。説明本文、画像、取得HTML、HTTPヘッダー、認証情報、キューは配布しません。調査で確認したサイトの記載とプロジェクトとしての公開判断は、[サイト確認記録](site-status.md)に分けて記録しています。

公開用スナップショットと読み込み用拡張ファイルを更新するには、検証済みのローカル辞書を明示して実行します。

```powershell
node scripts/package-data.js --input data/partial/RUN_ID/dictionary.json
npm run validate
npm run build
```

`package-data.js` は入力manifestのSHA-256と辞書スキーマを検証し、対応表と収集範囲の要約だけを `data/published/` にコピーして拡張をビルドします。部分データでも公開できますが、manifestの `complete: false`、不足ページ、解析保留を維持します。GitHubのZIPを展開した利用者は、収集CLIやNode.jsを実行せず `extension` をChromeへ読み込めます。
