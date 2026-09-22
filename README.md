# Finance Hub — 離線帳本

*Every account, every holding, every transaction — all in one place, and that
place is your own machine.*

一個放在自己電腦上的個人資產後台。銀行帳戶、券商、信用卡、貸款、台美股持股、錢包裡的幣、
每一筆進出，全部在同一個地方。

資料存在 `~/.finance-hub/finance.db`，**不上傳任何雲端、不對外連線、不需要帳號密碼**。
伺服器只綁 `127.0.0.1`。

這幾句不是自我宣告，是擋得住的：頁面帶著 `default-src 'none'` 的 CSP，瀏覽器會拒絕任何往外
的請求；測試會掃過所有會跑到的程式碼，出現外部網址就失敗；這個專案沒有 `package.json`，也
有測試和 git hook 確保它不會長出來。你可以自己讀完全部的原始碼，約五千行，沒有編譯步驟、
沒有 `node_modules`。

## 這是什麼，不是什麼

**是**一本自己一個人用的本機帳本：你自己開它、資料在你自己的磁碟上、程式碼你讀得完。
它的價值在於「你查得到每一筆數字是怎麼來的」，不在於功能多。

**不是**以下這些，而且多半是刻意的：

- **不是服務。** 沒有帳號、沒有登入、沒有雲端、沒有跨裝置同步——帳本就是一個檔案，待在你
  開它的那台機器上。（同一台要多開幾本測試帳，用 `FINANCE_PROFILE`，見
  [`docs/data.md`](docs/data.md)；要讓別的裝置連進來得自己用 `HOST`／`ALLOWED_HOSTS`
  放行，而因為沒有登入，放行就等於把整本帳攤在那個網段上，見
  [`docs/security.md`](docs/security.md)。）
- **不是保險箱。** `finance.db` 是明文 SQLite，任何能讀你家目錄的程式都讀得到。它安全是
  因為它只待在你的磁碟上；要加密請靠 FileVault 或全碟加密，不是靠這個程式。
- **不是記帳／報稅軟體。** 沒有預算、沒有自動分類規則、沒有發票、沒有報表範本。它記錄發生
  過什麼，不告訴你該怎麼花錢。
- **不會自己去抓股價。** 第一階段完全不對外連線，持股現價要自己填。要改成會抓的，那是第二
  階段，而且必須是可以關掉的選項。
- **沒有 AI 功能。** 產品決定，不是還沒做。
- **不給你一個跨幣別的單一總淨值**——設了匯率也一樣不會加總。USD 和 TWD 湊成一個數字只是
  估計值，而且會在你改匯率時默默變動。理由在 [`docs/money.md`](docs/money.md)。
- **不是產品。** 一個人維護的個人專案，沒有保固、沒有支援、沒有相容性承諾——AGPL 第 15、
  16 條把這件事寫成了法律文字，這裡只是先講白。

## 跑起來

```bash
node server/index.js
# → http://127.0.0.1:4321
```

需要 **Node 22 以上**（用的是內建的 `node:sqlite`）。**沒有 npm 依賴，沒有 build，沒有
CDN**，`npm install` 不用跑，斷網也能完整運作。改連接埠：`PORT=5000 node server/index.js`。

## 第一次使用

1. **設定匯率** — 只有單一幣別的話跳過。跨幣別轉帳要靠它才認得出來。
2. **建立機構與帳戶** — 或直接跳到第 3 步，讓匯入幫你建。
3. **匯入 CSV** — 丟檔案進去就好。**還沒有帳戶也沒關係**：系統會從檔案內容把機構、帳戶
   名稱、類型、幣別、期初餘額都填好，跳一個視窗讓你確認，有錯直接改。有餘額欄的對帳單
   （BoA / Chase 的支票帳戶）連**期初餘額都算得出來**。信用卡沒有餘額欄，期初欠款要自己
   填，而且**欠款是負數**。
4. **配對轉帳** — 匯完後交易頁上方會提示疑似轉帳，配對掉，收支才不會被自己搬錢灌水。
5. **對帳** — 帳戶頁每個帳戶點「對帳」，把網銀顯示的餘額記一筆。系統會指出差多少。
6. **看完整度** — 完整度頁是帳戶 × 月份的格子圖，直接告訴你哪幾個月帳本什麼都不知道。
   沒有交易的月份不算缺口，只要那個月有對帳把它確認掉。
7. **設分類規則** — 消費頁下方。八種對帳單裡只有兩種自己帶分類欄，其餘都靠規則補。
   設好之後匯入就會自動帶分類，也可以一次套用到已經匯進來的交易。

## 開發

```bash
node --watch server/index.js    # 改檔自動重啟
node --test                     # 跑測試（自己開 server、自己收拾）
```

測試用 Node 內建的 `node:test`，會自己挑一個空的 port、開一個暫存資料庫，跑完全部清掉，
不會碰到你的真實帳本。前端沒有 build，改完重新整理就好。

clone 完跑一次 `git config core.hooksPath githooks`，擋住把 `.db`／`.csv`／`.env` commit
進去。

想看看它長什麼樣子、又不想先匯入自己的對帳單：

```bash
FINANCE_PROFILE=demo node scripts/seed-demo.js   # 18 個月、九個帳戶的編造資料
FINANCE_PROFILE=demo node server/index.js
```

那是另一本帳（`~/.finance-hub/demo.db`），側邊欄徽章會轉成琥珀色標出來，個人帳本不受影響
——腳本也拒絕寫進去。

## 放上網路（示範版）

同一份前端不需要伺服器也能跑：換一個把 `/api/...` 從記憶體回掉的 storage adapter，資料是
同一支 `shared/demo-seed.js` 當場生出來的編造帳本。打包就是複製：

```bash
node scripts/pack-demo.js              # → ./dist
python3 -m http.server -d dist 8000    # 想先自己看一眼
```

`dist/` 跟 repo 裡的檔案一個位元組都不差，只多兩樣：`connect-src 'none'` 的 CSP——示範版沒
有伺服器可以連，所以讓頁面連「能力」都沒有——以及打上去的 commit，側邊欄用它組出原始碼連
結。**AGPL 第 13 條要的是「使用者正在跑的那個版本」**，所以連結指的是 commit 不是分支，工
作目錄不乾淨就不給打包。細節在 [`docs/security.md`](docs/security.md)。

## 文件

| | |
|---|---|
| [`docs/formats.md`](docs/formats.md) | 支援哪些對帳單、各家差在哪、四個會讓數字安靜出錯的坑 |
| [`docs/money.md`](docs/money.md) | 金額慣例（原幣不折算、負債為負、持股分開算）、完整度、資料表 |
| [`docs/spending.md`](docs/spending.md) | 消費分析、分類規則、固定扣款怎麼認出來的 |
| [`docs/data.md`](docs/data.md) | 帳本放在哪、profile、備份、不讓資料跑進版控 |
| [`docs/security.md`](docs/security.md) | 為什麼只綁 `127.0.0.1` 還不夠，四道防線各擋什麼 |

`CLAUDE.md` 是給改這份程式碼的人（或 agent）看的，比上面幾份細。

## 第二階段（尚未實作）

券商 API 自動同步（台股 Shioaji／富邦，美股 IBKR Flex Web Service／Firstrade），有了 API
才有持股歷史，淨值走勢才能含持股，也才能算 XIRR 和時間加權報酬。目前股價是手動填的。

台灣的銀行沒有對等的路：Plaid 不支援台灣，開放銀行第三階段實務上沒對個人開放，自己爬網銀會
卡 OTP 且違反約定條款。**銀行端長期就是 CSV。**

## 授權

**GNU Affero General Public License v3.0 或更新版本**，完整條文在 [`LICENSE`](LICENSE)。

```
Copyright (C) 2026 Harry Chung

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more
details.

You should have received a copy of the GNU Affero General Public License along
with this program.  If not, see <https://www.gnu.org/licenses/>.
```

**為什麼是 AGPL 而不是 MIT。** 這個專案的整個賣點是「你可以自己讀完全部原始碼，自己驗證
那些隱私宣稱」。MIT 允許有人把它改成會往外送資料的版本、架成網站給別人用，而且不必公開他
改了什麼——那樣賣點就只剩下這個 repo，fork 之後就不成立了。AGPL 第 13 條要求：**改過的
版本只要架起來讓別人透過網路使用，就必須把那個版本的原始碼提供給那些使用者。**（改完拿給
別人下載安裝的那種版本，第 5 條本來就要求附原始碼，那一條一般的 GPL 也有；第 13 條補上的
是「架成網站」那一種。）MIT 兩種都不要求。

自己跑、自己改、不拿給別人用，AGPL 不要求你做任何事。
