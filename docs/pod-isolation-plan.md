# Pod 隔離執行 Agent：現況探測與分階段計畫

建立日期：2026-11-13。狀態：**計畫，尚未實作**；階段 1 到 5 都沒有動過 k8s 或 bridge。本文件記錄現況探測、對一份外部架構建議的取捨，以及建議的順序，供日後開需求卡時依據。

本文件只寫一般性的架構與結論，不記錄個人機器的位址、主機名稱、帳號或實際部署配置；那些屬於各自的環境設定，不進 repo。

## 背景

使用者提供一份外部對話的建議（雲端 Control Plane、家用 NAS／K3s 與其他 VM 當 Execution Plane，用 Tailnet Grants、主機防火牆、Kubernetes NetworkPolicy、Egress Gateway 四層防護），要求規劃走 pod 隔離跑 agent。

## 現況探測（2026-11-13，唯讀，從遠端 agy pod 內往外連）

環境：自架 NAS VM 上的單節點 k3s（v1.36）；遠端 agy pod 是一個獨立 namespace 的 Deployment（Ubuntu 容器，持久化儲存掛載到 `/root`）。

| 項目 | 結果 | 風險 |
|---|---|---|
| 連 NAS 主機的 ssh（22） | 通 | agent 可直接碰 NAS 的 ssh |
| 連 k8s API（叢集內 Service 位址，443） | 通 | pod 內有 ServiceAccount token；預設 SA 目前權限只有探索與自我檢查類，影響有限 |
| 連家用 LAN 閘道的 HTTP（80） | 通 | 能碰區網設備 |
| 連網際網路（公開 HTTPS 站台） | 通，不受限 | 沒有出口管控 |
| 連雲端 metadata（link-local 位址） | 不通 | 不在雲端上，不適用 |
| 執行身分 | root（uid 0） | 目前 bridge 的 review 流程（信任寫入、hook 腳本、card review 根目錄）都假設 `/root` |
| NetworkPolicy | 全叢集只有另一個工作負載的一條規則（只排除 tailnet 網段）；agy pod 的 namespace 沒有 | agy pod 沒有任何網路隔離 |
| RuntimeClass | 只有 `crun`、`lunatic` | **沒有 gVisor**，外部建議的 gVisor 隔離目前做不到 |
| pod 內的憑證 | 有 agy 的 OAuth token（在 agy 的設定目錄）；沒有 ssh 私鑰（`.ssh` 只有 `authorized_keys`） | 被入侵時最有價值的目標是這個 token；出口管控只能降低外洩風險，不能杜絕 |

未驗證：k3s 內建的 NetworkPolicy 控制器是否實際生效（沒有實測阻擋）；agy／herdr 需要的外部網域清單；同一叢集上其他工作負載的用途與風險（本次沒檢查）。

## 對外部建議的取捨

**直接適用**

- Pod 預設拒絕、白名單放行；不掛載 ServiceAccount token、docker socket、hostPath。
- 出口兩層控制：NetworkPolicy 強制，Proxy 做網域白名單。只設 `HTTP_PROXY` 環境變數不是安全邊界。
- 管理流量與 agent 出網流量分開。

**先不採用，或需要先確認**

- **雲端 Control Plane：**bridge 目前跑在使用者的開發機，連著 Discord 與 Herdr；搬到雲端是另一個專案，牽動 hook、`ssh -R` 反向轉發與 Discord 閘道。
- **Tailnet Grants：**只在多台機器互連時才有意義；目前只有一個 NAS，連線用 `kubectl exec` 當 ssh ProxyCommand，沒有對外連接埠；tailscale 目前也決定先不設。
- **每任務一個 Job Pod：**安全性最好，但 bridge 目前沒有「在 pod 上建立可寫 checkout，做完取回成果」的機制（見階段 3）。
- **gVisor：**叢集沒有對應 RuntimeClass。
- **外部建議的 YAML：**是示範值，不能直接套用（例如 Proxy 以固定 Pod IP、DNS selector 的標籤需對照實際 CoreDNS）。

## 分階段計畫（建議順序）

**階段 1：補遠端 agy pod 的網路隔離（只動 k8s，不改 bridge）**

- agent 的 namespace 加 default-deny egress，再允許 DNS 與網際網路，但排除私有網段（RFC 1918）、k8s API、link-local。
- `automountServiceAccountToken: false`。
- 驗收：重跑上表的探測，NAS ssh、k8s API、LAN 變成不通；網際網路與 agy 正常運作；先確認 NetworkPolicy 控制器真的生效，否則是假隔離。
- 風險：pod 的網路會變嚴格；做之前先備份 Deployment yaml 並備好還原指令。bridge 與 pod 的連線走 `kubectl exec`（經 NAS 的 API，由外部發起），預期不受影響，但要實測 bridge 的 machine 仍顯示 connected。

**階段 2：出口 Proxy 與網域白名單**

- 在獨立 namespace 放 Squid（或 Envoy），agent namespace 只能連 Proxy 的連接埠。
- 白名單先「只記錄不擋」，收集 agy、herdr、GitHub、套件源實際用到的網域，再收緊。
- Proxy 本身要封鎖內網、metadata、k8s API，否則成為 SSRF 入口。
- 限制：HTTPS CONNECT 只能看到目的地，無法檢查內容；非 HTTP 協定要另外處理。

**階段 3：bridge 支援 remote 的 implement／verify（程式變更，需先寫需求卡）**

- 目前 remote 只支援 reviewer（task 內與 PR 後的 card review，ISSUE-143）。
- 需要：pod 上可寫的 checkout、成果取回方式（patch 或 push 到卡片分支）、GitHub 憑證只給最小權限、不複製主控端憑證到 pod。
- 同時是「agy 要能擔任所有角色」目標（本機 agy Worker 的 ISSUE-147 至今未重現）的替代路線。

**階段 4：非 root 與每任務一次性 pod**

- 影響面大（信任寫入、hook 腳本都假設 `/root`），放最後，並評估是否真的需要。

**階段 5：雲端控制端與 Tailnet Grants**

- 先決定是否真的要搬，再開需求卡；若要做，需要 tag 設計、移除全開放規則、用 Policy Tests 驗證「Worker 不能主動連回 Controller」。

## 待使用者決定

1. 範圍：只做 NAS 上 pod 的隔離（階段 1 到 3），還是也要規劃雲端。建議先做前者。
2. 階段 1 何時做。
3. 是否為階段 3 開需求卡。

## 驗證與紀錄要求

每個階段的驗收都要附日期、環境與結果；NetworkPolicy 與 Proxy 要用「應該成功」與「應該失敗」兩組連線測試證明（直接出網、繞過 Proxy、內網、k8s API、metadata）。單元測試或 yaml 套用成功不等於隔離生效。
