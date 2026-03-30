# MIN-Tube-Pro

CG / YouTube web app.  
「MIN-Tube-Pro」は、YouTube や動画視聴をより快適にするための Web アプリです。  
ブラウザからすぐにアクセスでき、PC・スマホ問わず軽量に動作することを目指しています。

デモ: https://min-tube2.vercel.app
    : https://min-tube-pro.vercel.app

---

## デプロイ

ワンクリックで自分の環境にデプロイできます。

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/mino-hobby-pro/MIN-Tube-Pro)

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/mino-hobby-pro/MIN-Tube-Pro)

### Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?templateUrl=https://github.com/mino-hobby-pro/MIN-Tube-Pro)

---

## 特徴

- **軽量:** HTML + JavaScript ベースのシンプル構成
- **ホスティングしやすい:** Vercel / Render / Railway などの PaaS に対応しやすい構造
- **Node.js 対応:** `index.js` + `Procfile` によるサーバー起動が可能
- **設定ファイル付き:** `render.yaml` / `railway.json` などのデプロイ設定ファイルを同梱

---

## 必要要件

- **Node.js** (推奨: LTS)
- **npm** または **yarn**

---

## ローカル開発

```bash
# 依存関係のインストール
npm install

# 開発サーバー起動
npm start
# または
node index.js
