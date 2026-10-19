# push-service

iOS 版 App 的 APNs 推送转发服务（部署在 push.luojiajiang.uk）。

流程：iOS App 拿到 APNs 设备令牌 → 登记到这个服务，拿到 `{pushId, secret}` → 网页把它们交给你自己的 relay → relay 调 `<url>/v1/send`，这里签 APNs JWT 并通过 HTTP/2 发出去。relay 从不接触 APNs 令牌。

单文件，只用 Node 22 内置模块，没有 npm 依赖。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `APNS_KEY_FILE` | 是 | `.p8` 私钥文件路径 |
| `APNS_KEY_ID` | 是 | 私钥的 Key ID |
| `APNS_TEAM_ID` | 是 | Apple Developer Team ID |
| `APNS_TOPIC` | 是 | App 的 Bundle ID |
| `DATA_DIR` | 是 | 存放 `registrations.json` 的目录 |
| `APNS_ENV` | 否 | 默认 `production`，可选 `sandbox` |
| `PORT` | 否 | 默认 `8787` |
| `HOST` | 否 | 默认 `127.0.0.1`（由 Caddy 反代） |

缺少必填项时启动会直接报错退出。

## 接口

- `GET /healthz`：返回 `ok`
- `POST /v1/register`：`{ token, env?, pushId?, secret? }` → `{ pushId, secret }`。带上正确的 `pushId` + `secret` 可以更新令牌
- `POST /v1/send`：`{ pushId, secret, title, body, data }` → `{ ok: true }`。令牌已失效时返回 410 并删除登记
- `POST /v1/unregister`：`{ pushId, secret }`
- `POST /v1/live/token`：`{ pushId, secret, kind, key?, token }`。App 上报 Live Activity 令牌：`kind` 为 `start`（push-to-start 令牌）或 `update`（单个活动的更新令牌，`key` 为 `win|windowId|threadId`）
- `POST /v1/live`：`{ pushId, secret, key, event, attributes, state, alert, priority?, dismissAt? }`。relay 通知活动状态变化：`event` 为 `update` 或 `end`；首个 `update` 会向 `start` 令牌发开始推送，活动条目最多保留 8 小时。Live Activity 不需要额外配置，同一密钥和 topic 即可

限流：注册每 IP 每小时 20 次；发送每个 pushId 每分钟 60 次；live/token 每 IP 每小时 120 次；live 每 pushId 每分钟 120 次；每 IP 每分钟 600 次。日志不记录标题、正文、令牌和 secret。

## 部署

```sh
sudo useradd --system --home /opt/remote-agent-push rapush
sudo install -d -o rapush -g rapush /opt/remote-agent-push/app /opt/remote-agent-push/data
sudo cp push-service/index.mjs /opt/remote-agent-push/app/
sudo cp /path/to/AuthKey_XXXX.p8 /opt/remote-agent-push/AuthKey.p8
sudo chown rapush /opt/remote-agent-push/AuthKey.p8 && sudo chmod 600 /opt/remote-agent-push/AuthKey.p8
```

`/opt/remote-agent-push/env`（权限 600）：

```sh
PORT=8787
HOST=127.0.0.1
APNS_KEY_FILE=/opt/remote-agent-push/AuthKey.p8
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=XXXXXXXXXX
APNS_TOPIC=com.example.agentremote
APNS_ENV=production
DATA_DIR=/opt/remote-agent-push/data
```

`/etc/systemd/system/remote-agent-push.service`：

```
[Unit]
Description=Remote Agent push service
After=network-online.target
Wants=network-online.target

[Service]
User=rapush
WorkingDirectory=/opt/remote-agent-push/app
EnvironmentFile=/opt/remote-agent-push/env
ExecStart=/usr/bin/node index.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/remote-agent-push/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

启动并检查：

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now remote-agent-push
curl https://push.luojiajiang.uk/healthz
journalctl -u remote-agent-push -f
```

Caddy 里加一段反代（域名换成自己的）：

```
push.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

更新服务：替换 `/opt/remote-agent-push/app/index.mjs` 后 `sudo systemctl restart remote-agent-push`。
