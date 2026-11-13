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
| 4 | remote implement／fixer、每個任務獨立短命 pod、非 root | 規劃 |
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

## 未驗證項目

- 各 agent CLI（agy 等）是否支援經 proxy 出站。
- proxy 白名單的完整網域清單（需觀察 log 才知道）。
- NetworkPolicy 對 proxy 的行為在目前叢集 CNI 的實測。
- token manager 與 bridge 的認證方式與租約回收。
- 私有 repo 的 PR 階段 reviewer 流程（目前只支援匿名 https 的公開 repo）。

## 後續

每階段開獨立卡片與 PR，並依 AGENTS.md 更新 `docs/known-issues.md`、`SPEC.md`；實機驗證與單元測試分開記錄。
