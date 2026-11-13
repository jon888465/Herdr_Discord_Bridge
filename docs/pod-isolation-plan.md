# Pod 隔離執行 agent：規劃

2026-11-13。**規劃文件，尚未實作**（第 1 階段已由操作者在自己的叢集手動套用，規則不在本 repo，見下）。本文只寫一般性架構，不放任何位址、主機名、帳號或實際部署配置（公開 repo，PR 歷史無法刪除）。

目標：agent 跑在 Kubernetes pod，bridge 仍是唯一調度者；agent 即使被 prompt injection 或自己出錯，也碰不到內網、叢集控制面與長期憑證。

## 威脅模型

- agent 會執行任意指令與讀寫檔案，視為不可信。
- 要擋的：橫向移動到內網與叢集 API、竊取長期憑證、對外資料外洩、濫用已發出的短效憑證。
- 不在範圍：bridge 主機本身被攻陷、供應商端（模型服務）風險、容器逃逸（需 gVisor 等額外沙箱，列為後續）。

## 目前實際做法（資料流）

- **task 內的 remote 唯讀角色**（diagnose／review／verify，SPEC.md「task 內 remote 唯讀角色」）：bridge 在本機把工作樹做成一個暫時 commit（含未追蹤、不含 ignored），打成 git bundle，經 ssh stdin 送進 pod、`bundle verify` 後 checkout；**不推送到 origin**，pod 不需要任何 GitHub 憑證，也不需要出站到 GitHub。
- **PR 之後的 card reviewer**（ISSUE-143）：pod 以**匿名 https** 從 GitHub clone `origin` 並 checkout PR head；**這一步需要 pod 出站連到 GitHub**，只適用公開 repo，私有 repo 需要下面的 token manager。
- 管理通道：bridge 經 ssh（`kubectl exec` 轉接，pod 不對外開埠）進 pod，轉發 herdr socket 與 hook socket。

## 分階段

| 階段 | 內容 | 狀態 |
|---|---|---|
| 1 | NetworkPolicy 預設拒絕對私有網段、link-local、CGNAT、叢集 API 的出站，只放行叢集 DNS 與公網；Deployment 設 `automountServiceAccountToken: false` | 操作者已手動套用並實測（2026-11-13，連線層與 remote reviewer 成功路徑；規則檔不在本 repo） |
| 2 | egress proxy pod：agent pod 只能連 proxy 與 DNS，proxy 以網域白名單過濾（先只記 log，觀察後再強制） | 規劃 |
| 3 | token manager：以 GitHub App 發短效、限單一 repo 的 installation token | 規劃，等 remote 寫入角色才需要 |
| 4 | remote implement／fixer、非 root；pod 依風險分組長駐，一次性 pod 只用於高風險寫入（見「pod 要不要動態建立」） | 規劃 |
| 5 | 雲端控制平面與 tailnet 存取控管（grants／tag） | 規劃 |

## 借鏡雲端平台的對應

| 雲端做法 | 本方案 |
|---|---|
| VPC 出口只走 NAT／proxy | agent pod 只能連 egress proxy |
| metadata／STS 發短效憑證 | token manager 發短效 GitHub token |
| 每個任務一個 role | 每個任務一把只限單一 repo、最小權限的 token |
| 稽核紀錄 | proxy 與 token manager 的存取紀錄 |

## 第 2 階段：egress proxy

- agent pod 的 NetworkPolicy 改為只允許連 proxy 與 DNS；proxy 用 CONNECT 依網域白名單轉發，**不解密 TLS**（解密需在 agent 安裝自訂憑證，部分 CLI 因憑證釘選會壞，先不做）。
- 白名單只列必要網域（GitHub、模型供應商端點、必要的套件庫）；先 log-only，觀察一段時間再強制。
- **最大風險：**agent CLI 是否尊重 `HTTPS_PROXY`。不尊重時，NetworkPolicy 擋直連會直接失敗。實作前要先在測試 pod 驗證每種 agent。
- proxy 是單點與高價值目標：獨立 namespace、只開必要埠、設定最小化。

## 第 3 階段：token manager

- 以 **GitHub App**（不用個人長期 token）：installation token 1 小時過期，可限定 repo 與權限；App 私鑰只存在 token manager，agent 永遠看不到私鑰。
- **授權由 bridge 決定**「這個任務可取得哪個 repo、什麼權限」，agent 不能自行宣稱。
- 發放方式：(a) pod 內放 git credential helper，向 token manager 取 token；(b) proxy 對 GitHub 網域自動加 `Authorization` 標頭，agent 完全碰不到 token（需要 TLS 解密，列為後續）。先做 (a)。
- agent 向 token manager 證明身分：用限定 audience 的 projected service account token，不重新開啟完整 API 權限。
- 短效 token 在效期內仍可被濫用，所以要配合 GitHub ruleset：agent 只能 push 約定的分支前綴，不能動主線，PR 仍須 review。
- 私鑰至少以 Secret 加 RBAC 保護；後續評估 KMS 或外部 secret store。

## 第 5 階段與 tailnet 的取捨

tailnet 提供節點間網路連通，也能用 Taildrop、ssh、rsync 傳檔，但**傳檔能力不等於該開放 agent 之間互連**：

- 不採 agent 對 agent 直連。維持 hub-and-spoke：所有檔案與指令經 bridge（現行的 bundle 快照就是這個模式），agent 之間互不可達，才不會出現橫向移動路徑。
- 若 pod 要加入 tailnet，要以 tag 與 grants 限縮到只能連 bridge 與必要服務；加入前 NetworkPolicy 需放行 CGNAT 網段，兩邊同時收緊。
- Taildrop 對 tag 節點的支援與 ACL 行為需實測，本文不假設。

## pod 要不要動態建立

結論：**不需要**，預設用少數長駐 pod。

- 效率：目前 pod 的啟動腳本每次重建都會安裝套件、sshd 與 herdr，實測要數分鐘。動態建 pod 若沒有預建映像，每個任務都要等這麼久。
- 隔離不靠「一任務一 pod」：現行每個 assignment 都是新 session、新目錄、用完清理；真正的防線是出站管控、短效憑證與唯讀角色。
- 建議分組：唯讀 reviewer 一組長駐 pod；之後有寫入權限的角色另一組（權限、憑證、白名單各自獨立）。
- 一次性 pod 只用於「寫入角色加不可信 repo」，且必須先有預建映像（把套件、sshd、herdr 烤進映像，啟動不再安裝）。
- 長駐 pod 要處理重啟後的恢復：herdr server 需能自動啟動，bridge 專用的 wrapper 等設定要寫進部署定義，不能只存在容器檔案系統。

## skill 與 agent 設定

- 現況：pod 上沒有任何 skill；唯讀 reviewer 的提示由 bridge 帶入卡片內容與驗收條件，不依賴 skill，目前沒有缺口。
- 需要時的做法：**不要**把個人 skill 整個目錄複製進映像或公開 repo（可能含個人資訊與偏好）；只挑角色需要的，列成白名單。
- 以**唯讀**方式提供（bridge 啟動 agent 前同步，或唯讀 volume／ConfigMap）。skill 是 agent 會照做的指令，agent 若能改自己的 skill 目錄，一次 prompt injection 就會污染之後所有 session。
- 用內容雜湊固定版本，稽核時能知道某次 review 用的是哪一版指令。
- 不同 agent 種類的 skill 位置與格式不同，不能共用一份目錄；實作前逐種確認。
- 持久儲存上的 agent 設定備份會累積（ISSUE-149），沒有清理機制前不要在其中放需要保密的內容。

## agent 登入憑證

agent 自己的登入憑證（例如 agy 的 OAuth 憑證）存放在 pod 的持久儲存，agent 讀得到，是**長期憑證**。token manager 只處理 GitHub token 並不涵蓋這一項。待評估的緩解：

- egress proxy 白名單只放該 agent 供應商所需網域，降低被外送的路徑。
- 評估能否改為由外部注入、或使用範圍更小、可撤銷的憑證。
- 一旦懷疑外洩，流程是撤銷後重新登入，不是清歷史。

目前只確認風險存在，沒有解法；需要使用者決定是否接受或投入改造。

## 與 DeerFlow 的比較

2026-11-13，依 bytedance/deer-flow 官方文件（`docs/guide/` 與 `backend/docs/CONFIGURATION.md`）整理；另有一篇第三方介紹文章，內容多為行銷說法，不作依據。**部分段落（CONFIGURATION.md 的沙箱 provider 與網路政策小節、skills 的導出限制）只讀到摘要而非逐字，下表標「摘要」者需再核對原文。**定位不同：DeerFlow 是自帶 Lead 與子代理的一體式引擎；本專案是 bridge 調度既有的 CLI agent，流程以卡片、PR、review、CI 為主。

| 面向 | DeerFlow（官方文件） | 本規劃 |
|---|---|---|
| 沙箱模式 | 三種：local、Docker（AIO）、Docker＋Kubernetes provisioner；**預設是 local**，文件自稱 local「不是強邊界」，host bash 預設關閉 | agent 一律在 pod；沒有「本機直接執行」的隔離宣稱（本機 agent 的權限風險另列於 ISSUE-125） |
| 出站管控 | AIO 預設 open（為相容）；可設 isolated／allowlist，allowlist 可經人工核准卡片臨時放行網域；私網、loopback、link-local、雲端 metadata 位址永不可核准；受限模式只支援本地 Docker，provisioner 模式 fail closed（摘要）；**文件未見 Kubernetes NetworkPolicy** | 第 1 階段 NetworkPolicy 已套用；第 2 階段 proxy 白名單 |
| 憑證 | 沙箱指令刻意不繼承 gateway 的 API key，需明確注入；本機 bash 輸出會脫敏；但 Lark 憑證以唯讀掛載進沙箱、沙箱內程式讀得到，文件承認要等 sidecar broker 完成；**沒有通用 token manager 或短效憑證機制** | 第 3 階段 GitHub App 短效 token；agent 登入憑證缺口見上節 |
| Kubernetes provisioner | 只有定性描述「最強隔離」；pod 的非 root、service account、資源限制、NetworkPolicy、清理細節**文件中沒找到**（指向另一份未讀的 Setup Guide） | 無法逐項比較 |
| Skills | `SKILL.md`（`name`、`description` 必填，另有 `allowed-tools`、`required-secrets` 等）；漸進載入；可依 agent 設白名單（省略＝全部、空清單＝全部停用）；安裝 `.skill` 歸檔要過確定性掃描（私鑰、shell 執行）與 LLM 掃描；`allowed-tools` 文件明講**不是安全邊界** | 白名單、唯讀、雜湊固定版本；唯讀角色由 bridge 強制，不靠 skill 的中繼資料 |
| 子代理驗證 | 「deterministic tool receipts」：回報要引用工具回執，主代理核對；沒引用的標 UNVERIFIED；`acceptance_criteria` 結果為成立／不成立／UNVERIFIED；文件明講回執驗證**不證明未引用敘述的真實性或完整性** | verify 角色回報必須 exit 0 的檢查指令；Lead 彙整是否逐項核對證據待檢視 |
| 並行 | `max_concurrent_subagents`、`max_total_per_run` | 一次一張卡，task 內依賴排序 |
| 安全定位 | 預設只綁 loopback；文件寫「Gateway admin 等同主機上的程式碼執行」；部分 IM 通道 `allowed_users` 留空代表允許所有人 | bridge 以 Discord 允許清單加提及規則限制入口 |

**可借鏡：**

- **網域核准流程：**新網域不是永久開放，而是由人核准並限時放行（對應 Discord 核准訊息）；私網、link-local、雲端 metadata 永不可核准；受限模式不支援時 fail closed。可納入第 2 階段 proxy 設計。
- **沙箱不繼承父程序憑證、明確注入：**對應 token manager 的「只發給該任務需要的」。
- **skill 宣告所需 secrets（`required-secrets`）：**bridge 只注入 skill 宣告的項目。
- **skill 安裝前掃描：**同步白名單 skill 進 pod 之前先做確定性掃描。
- **子代理回報引用回執、否則標未驗證：**可對照 Lead 彙整與 verify 的證據要求。
- **容量控制：**pod 變多時需要並行上限與單任務委派上限。

**驗證了本規劃的方向：**即使是這類產品，文件也承認沒有 token manager、沙箱內可讀憑證要等 broker、provisioner 的出站與 pod 安全設定沒有寫明；第 3 階段的短效、限 repo 的 GitHub App token 與第 1 階段的 NetworkPolicy 是目前沒看到同類做法的部分（僅依已讀文件，不代表它們沒做）。

**要提防的：**local 模式（預設）等於沒有隔離；IM 通道使用者白名單留空的語意必須明確。本專案的 Discord 授權檢查（`src/discord.ts`）對 `allowedGuildIds`、`allowedChannelIds`、`allowedUserIds` 都是「留空＝不限制該維度」（fail-open），只有 bot 開關這類控制要求使用者 ID 在清單內；部署時三者都應填寫，是否改成留空即拒絕列為後續待決項目（尚未決定、未實作）。

## 未驗證項目

- 各 agent CLI（agy 等）是否支援經 proxy 出站。
- proxy 白名單的完整網域清單（需觀察 log 才知道）。
- NetworkPolicy 對 proxy 的行為在目前叢集 CNI 的實測。
- token manager 與 bridge 的認證方式與租約回收。
- 私有 repo 的 PR 階段 reviewer 流程（目前只支援匿名 https 的公開 repo）。
- 各種 agent 的 skill 位置與格式、是否有「信任子資料夾」之類的限制。
- agent 登入憑證的外部注入或更小範圍憑證是否可行。
- 預建映像與長駐 pod 自動恢復（herdr server 自動啟動）的做法。
- DeerFlow 的 Provisioner Setup Guide、`SECURITY.md`、compose 檔與 `config.example.yaml` 尚未讀取；其文件對「CLI 憑證目錄是否預設掛載」前後自相矛盾，未核實。

## 後續

每階段開獨立卡片與 PR，並依 AGENTS.md 更新 `docs/known-issues.md`、`SPEC.md`；實機驗證與單元測試分開記錄。
