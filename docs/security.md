# 為什麼「只綁 127.0.0.1」還不夠

綁 loopback 擋得住別台機器，擋不住**你自己這台機器上的瀏覽器**。有兩個真實的攻擊路徑，所以
另外加了兩道檢查。三道一起構成「誰可以連到這台伺服器」，第四道 CSP 則決定「這個頁面可以連
去哪裡」。

## DNS rebinding

你逛到 evil.com，它把自己的網域重新解析到 `127.0.0.1`。瀏覽器認為還在跟 evil.com 講話，同源
政策整個失效，那個頁面就能讀走你整本帳。

這種請求帶的是 `Host: evil.com`，所以伺服器只認 `127.0.0.1:PORT` / `localhost:PORT`，其餘
一律 403。

## CSRF 寫入

讀取本來就被擋住——我們不回 `Access-Control-Allow-Origin`，瀏覽器不給對方讀 response。但
跨站 `POST` 只要用 `text/plain` 這類「simple」content type 就不會觸發 preflight，請求會直接
送達。

所以：非 GET 請求若帶 `Origin` 就必須是自己，且有 body 的請求一律要
`Content-Type: application/json`（這會強制 preflight，而我們不回應 preflight）。

## CSP 是第四道，也是唯一由瀏覽器替我們執行的

`default-src 'none'` 決定頁面可以連去哪裡，這才是讓「不對外連線」從習慣變成機制的東西。它在
request handler 最上面設定一次，所以每個 response 都帶著，403 也不例外。

`style-src` 開了 `'unsafe-inline'`，只因為畫面上還有一些行內 `style=` 屬性——那是還沒清乾淨
的債，不是可以往別的指令加來源的理由。在 `script-src`、`connect-src` 或 `img-src` 加一個網域
或一個 `*`，帳本就開始跟別人說話了，所以 `test/api.test.js` 會因此失敗。

## 沒有對外連線，而且是擋得住的

`test/deps.test.js` 會掃 `web/`、`shared/`、`server/`、`scripts/` 找外部網址，掃 `style.css` 找外部的
`url()` 與 `@import`。字型的 `@import` 是這件事的安靜版本——它會在每次開頁時告訴陌生人的伺
服器，這台機器剛打開了帳本。

這個專案也沒有 `package.json`：`test/deps.test.js` 和 `githooks/pre-commit` 都會拒絕
`package.json` 或 lockfile 出現，因為這是最容易被一個「其他部分都正常」的 commit 破壞的規則。

## 放上網路的那份，CSP 更緊

示範版（`node scripts/pack-demo.js` 打出來的 `dist/`）沒有伺服器：每一條 `/api/...` 都是
分頁裡的一個 Map 回的。既然沒有東西要連，那就不要留著能連的能力——它送的是
`connect-src 'none'`，頁面因此**沒有辦法**把任何東西送去任何地方。這比隱私政策強的地方在
於訪客可以自己確認：打開 network tab，或者直接看 response header。

兩份 CSP 只差這一個指令，而且兩份都從 `server/csp.js` 同一個清單出來——第二份複本會在下次
改動時默默走樣，而唯一會注意到 CSP 被放寬的，只有讀它的人。

它同時以兩種形式送出，因為兩種的失效方向剛好相反：

- **`_headers`**（Cloudflare Pages、Netlify 讀得到）是真正的那份，帶得動
  `frame-ancestors 'none'`。
- **`<meta http-equiv>`** 是地板，給讀不到 `_headers` 的 host。HTML 規格要求解析器忽略
  meta 裡的 `frame-ancestors`（還有 `report-uri`、`sandbox`），所以那種 host 擋不了別人
  把這頁包進 iframe。`server/csp.js` 直接把那一條從 meta 版拿掉，而不是送一個瀏覽器會丟掉
  的指令：一份宣稱了自己沒在做的保護的政策，比一份沒宣稱的更糟。

## 原始碼連結是義務，不是禮貌

架起來的示範版是一個**改過**的版本——CSP 不一樣、多了 adapter 選擇、多了示範資料——而且是
透過網路給別人用。AGPL 第 13 條因此要求：把**使用者正在跑的那個版本**的原始碼，明顯地提供
給那些使用者。

所以側邊欄（每一頁都在）有一個連結，而它指的是 commit 不是分支：指向 `main` 是「提供之後
不知道會變成什麼的東西」，那不是同一件事。commit 由 `scripts/pack-demo.js` 打進
`<meta name="source-commit">`，而工作目錄只要有未提交的改動就拒絕打包——一個指向別人程式
碼的連結不是提供原始碼，是猜。

這也代表**為了示範版做的任何改動都必須 commit 進來**，不能只是在 host 那邊加一個 header。

那個網址是 `test/deps.test.js` 的不對外連線掃描唯一放行的外部網址，而且是完整比對而不是
網域前綴——前綴會連 `<script src>` 一起放行。它放行的理由是：那是一個人自己點的
`<a href>`，不是頁面發出的請求，`default-src 'none'` 一樣不准從那個網域載入任何東西。

## 要從區域網路連進來

用 `HOST` 和 `ALLOWED_HOSTS` 環境變數放行，並且清楚知道這等於把帳本攤在那個網段上。路徑是
這兩個變數，不是把上面任何一道檢查刪掉。
