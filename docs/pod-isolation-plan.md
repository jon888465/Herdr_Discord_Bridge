# Pod 隔離執行 Agent：現況探測與分階段計畫

建立日期：2026-11-13。狀態：**計畫，尚未實作**；階段 1 到 5 都沒有動過 NAS、k8s 或 bridge。本文件記錄現況探測、對一份外部架構建議的取捨，以及建議的順序，供日後開需求卡時依據。

## 背景

使用者提供一份 ChatGPT 對話的建議（GCP 當 Control Plane、NAS／K3s 與其他 VM 當 Execution Plane，用 Tailnet Grants、主機防火牆、Kubernetes NetworkPolicy、Egress Gateway 四層防護），要求「試想規劃走 pod 隔離跑 agent」。該分享連結抓不到內容（頁面由瀏覽器端渲染），是使用者把內容貼進對話後才讀到。

## 現況探測（2026-11-13，唯讀，從 agy-pod 內往外連）

環境：NAS VM `nasvm`（`10.0.0.239`）上的單節點 k3s v1.36.5；agy-pod 是 namespace `agy` 的 Deployment `agy`（Ubuntu 26.04 容器，掛載 20Gi 的 `home` PVC 到 `/root`）。

| 項目 | 結果 | 風險 |
|---|---|---|
| 連 NAS 主機 `10.0.0.239:22` | 通 | agent 可直接碰 NAS 的 ssh |
| 連 k8s API `10.43.0.1:443` | 通 | pod 內有 ServiceAccount token；預設 SA 目前權限只有探索與自我檢查類（`can-i --list` 僅見 `selfsubject*` 與唯讀的 `/api*`、`/.well-known*`），影響有限 |
| 連家用 LAN 閘道 `10.0.0.1:80` | 通 | 能碰區網設備 |
| 連網際網路（`https://api.github.com`） | 通，不受限 | 沒有出口管控 |
| 連 GCP metadata `169.254.169.254:80` | 不通 | 不在 GCP，不適用 |
| 執行身分 | root（uid 0） | 目前 bridge 的 review 流程（信任寫入、hook 腳本、`/root/herdr-card-review`）都假設 `/root` |
| NetworkPolicy | 全叢集只有 `openab-codex/no-tailnet-egress` 一條，且只排除 tailnet 網段（`100.64.0.0/10`、`fd7a:115c:a1e0::/48`）；`agy` namespace 沒有 | agy-pod 沒有任何網路隔離 |
| RuntimeClass | 只有 `crun`、`lunatic` | **沒有 gVisor**，外部建議的 gVisor 隔離目前做不到 |
| pod 內的憑證 | 有 agy 的 Google OAuth token（`/root/.gemini/antigravity-cli/antigravity-oauth-token`）；沒有 ssh 私鑰（`/root/.ssh` 只有 `authorized_keys`） | 被入侵時最有價值的目標是這個 token；出口管控只能降低外洩風險，不能杜絕 |

其他 namespace：`agent/sandbox`、`monitoring/glances`、`openab-codex/openab-codex` 與 kube-system 元件。

未驗證：k3s 內建的 NetworkPolicy 控制器是否實際生效（沒有實測阻擋）；agy／herdr 需要的外部網域清單；`agent/sandbox` 與 `openab-codex` 的用途與風險（本次沒檢查）。

## 對外部建議的取捨

**直接適用**

- Pod 預設拒絕、白名單放行；不掛載 ServiceAccount token、docker socket、hostPath。
- 出口兩層控制：NetworkPolicy 強制，Proxy 做網域白名單。只設 `HTTP_PROXY` 環境變數不是安全邊界。
- 管理流量與 agent 出網流量分開。

**先不採用，或需要先確認**

- **GCP 當 Control Plane：**bridge 目前跑在使用者的 Mac，連 Discord 與 Herdr；搬到 GCP 是另一個專案，牽動 hook、`ssh -R` 反向轉發與 Discord 閘道。
- **Tailnet Grants：**只在多台機器互連時才有意義；目前只有一個 NAS，連線用 `kubectl exec` 當 ssh ProxyCommand，沒有對外連接埠。使用者 2026-11-13 也決定 tailscale 先不設。
- **每任務一個 Job Pod：**安全性最好，但 bridge 目前沒有「在 pod 上建立可寫 checkout、做完取回成果」的機制（見階段 3）。
- **gVisor：**叢集沒有對應 RuntimeClass。
- **外部建議的 YAML：**是示範值，不能直接套用（例如 Proxy 以固定 Pod IP、DNS selector 的標籤需對照實際 CoreDNS）。

## 分階段計畫（建議順序）

**階段 1：補 agy-pod 的網路隔離（只動 k8s，不改 bridge）**

- `agy` namespace 加 default-deny egress，再允許 DNS 與網際網路，但排除 `10.0.0.0/8`、`192.168.0.0/16`、k8s API、link-local。
- `automountServiceAccountToken: false`。
- 驗收：重跑上表的探測，NAS:22、k8s API、LAN 變成不通；網際網路與 agy 正常運作；先確認 NetworkPolicy 控制器真的生效，否則是假隔離。
- 風險：agy-pod 網路變嚴格；做之前先備份 Deployment yaml 並備好還原指令。bridge 與 pod 的連線走 `kubectl exec`（經 NAS 的 API，由外部發起），預期不受影響，但要實測 `machine agy-pod: connected`。

**階段 2：出口 Proxy 與網域白名單**

- 在獨立 namespace 放 Squid（或 Envoy），agent namespace 只能連 Proxy 的 3128。
- 白名單先「只記錄不擋」，收集 agy、herdr、GitHub、套件源實際用到的網域，再收緊。
- Proxy 本身要封鎖內網、metadata、k8s API，否則成為 SSRF 入口。
- 限制：HTTPS CONNECT 只能看到目的地，無法檢查內容；非 HTTP 協定要另外處理。

**階段 3：bridge 支援 remote 的 implement／verify（程式變更，需先寫需求卡）**

- 目前 remote 只支援 reviewer（task 內與 PR 後的 card review，ISSUE-143）。
- 需要：pod 上可寫的 checkout、成果取回方式（patch 或 push 到卡片分支）、GitHub 憑證只給最小權限、不複製主控端憑證到 pod。
- 同時是「agy 要能擔任所有角色」目標（本機 agy Worker 的 ISSUE-147 至今未重現）的替代路線。

**階段 4：非 root 與每任務一次性 pod**

- 影響面大（信任寫入、hook 腳本都假設 `/root`），放最後，並評估是否真的需要。

**階段 5：GCP 控制端與 Tailnet Grants**

- 先決定是否真的要搬，再開需求卡；若要做，需要 `tag:` 設計、移除全開放規則、用 Policy Tests 驗證「Worker 不能主動連回 Controller」。

## 待使用者決定

1. 範圍：只做 NAS 上 pod 的隔離（階段 1 到 3），還是也要規劃 GCP。建議先做前者。
2. 階段 1 何時做。
3. 是否為階段 3 開需求卡。

## 驗證與紀錄要求

每個階段的驗收都要附日期、環境與結果；NetworkPolicy 與 Proxy 要用「應該成功」與「應該失敗」兩組連線測試證明（直接出網、繞過 Proxy、內網、k8s API、metadata）。單元測試或 yaml 套用成功不等於隔離生效。
