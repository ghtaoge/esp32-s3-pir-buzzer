# 感应小哨兵 · ESP32-S3

ESP32-S3 N16R8 人体活动提醒器，包含设备固件、PC 控制台和原生微信小程序。
新的一段活动触发一次限时鸣叫；持续活动不会让蜂鸣器一直响。
参数和事件保存在设备上，电脑、手机离开后仍独立运行。

当前接入的是 **HC-SR505 三脚 PIR 模块**，使用默认 `PIR` 模式：VCC→5V、GND→GND、OUT→GPIO13。
它只有电源、地和数字输出三根线。下文的 LD2410C 是可选扩展，不是当前所用硬件。

## 功能

- 兼容 HC-SR505 / HC-SR501 PIR；支持 LD2410C UART 雷达和运动/静止分离。
- 支持无源 PWM、有源通断和高/低电平触发蜂鸣器模块。
- 声音可选单音、双响、叮咚、警报，保留可调音高；所有预设都受统一鸣叫时长限制。
- PC：Chrome / Edge 本地网页，USB 串口或 BLE；无需 npm 安装依赖。
- 微信小程序：原生 BLE 扫描连接、布防、静音、停止、测试与参数设置。
- 保存配置需设备确认；雷达参数有真实 ACK 和回读，错误不伪装为成功。
- 最近 1000 条持久化事件、分设备缓存、断线增量同步、PC 分页与 CSV 导出。
- 有界收发/存储队列、5Hz 状态合并、后台存储任务、内存/循环/丢弃计数遥测。
- PC 自带明确标记的演示模式，没有开发板也能试操作；演示不操作硬件。

第一版是附近直连方案，不含云端、外网远控或小程序后台常驻告警。
PC USB 与手机 BLE 可以同时使用；BLE 本身只供一个中心设备连接。

## 接线

PIR 的 OUT 使用 **GPIO13**，蜂鸣器控制信号使用 GPIO7：

| 器件引脚 | ESP32-S3 |
| --- | --- |
| HC-SR505 / HC-SR501 VCC | 5V |
| PIR GND | GND |
| PIR OUT | GPIO13 |
| 三脚蜂鸣器 VCC | 按模块额定电压接电源 |
| 三脚蜂鸣器 GND | GND |
| 三脚蜂鸣器 S / IN | GPIO7 |
| LD2410C VCC（升级选配） | 5V |
| LD2410C GND | GND |
| LD2410C TX | GPIO18，ESP 接收 |
| LD2410C RX | GPIO17，ESP 发送 |

所有模块共地，GPIO 编号不是排针序号。常见 R8 模组的 GPIO35～37 已供 PSRAM 使用。
雷达按引脚丝印连接；UART 为 256000 8N1、3.3V 逻辑，模块用 5V 供电，供电能力需超过 200mA。

**三脚不代表一定有源，也不保证输入兼容 3.3V。** 带板载驱动、控制端兼容 3.3V 的蜂鸣器
模块无需额外电阻/三极管。裸电磁蜂鸣器不能照此让 GPIO 直接供电，5V 电源不能接入 GPIO。
默认 `PIR + 无源2kHz + 非反相输出`；有源模块请在参数页选择类型和触发极性。
固件 1.0.1 将 PIR 输入改为 GPIO13。更新后需重新烧录，并将 PIR OUT 接到 GPIO13。
无源模块可在 PC / 小程序选择声音预设，保存后点“测试蜂鸣器”试听实际输出。
有源模块只能改变通断节奏，不能改变内置音高；这些蜂鸣音不是语音播放。

PIR 上电默认预留 30 秒稳定时间，可调。HC-SR505 自身约 8 秒输出保持时间不能由软件消除，
期间的新动作无法分开识别。需要微动与可调检测区域时推荐 LD2410C，但雷达也不是手势计数器。
降低能量阈值更敏感，需要现场排除风扇、窗帘等干扰。距离配置按 0.75 米区间，固件会查询确认；
未接雷达、分辨率不兼容、无 ACK 或回读不符会明确失败，不会只改界面数字。

## PC 端

需要 Node.js 20+，推荐当前 LTS；无第三方 npm 运行依赖。

```powershell
npm start
```

使用桌面版 Chrome / Edge 打开 [本地控制台](http://127.0.0.1:8787)。
自定义端口：`node pc/server.js --port 8788`。
可先选“演示模式”；实际使用“连接 USB”选择 ESP32 串口，或“连接蓝牙”选 `S3-Sentinel-xxxxxx`。
请关闭占用同一串口的监视器，BLE 不要同时被另一手机占用。

参数只提交改动项，收到成功确认后更新。超时不会自动重放写操作，重连后先读取实际状态。
记录页每页 50 条、增量同步；CSV 使用 UTF-8 BOM，并对公式单元格做转义。
服务器只监听 127.0.0.1、只提供白名单静态资源。详见 [PC 使用说明](pc/README.md)。

## 微信小程序

微信开发者工具导入 `miniprogram/`。公开配置为 `touristappid`；实际 BLE 预览需要自己的 AppID、
开发权限和蓝牙隐私声明。将 `project.private.config.json.example` 复制为
`project.private.config.json`，在私有文件填写自己的 AppID，该文件已忽略。
不要提交上传密钥、AppSecret 或其他项目私有配置。

使用原生 wx BLE API，支持三页控制/调参/记录。按稳定芯片 deviceId 缓存最多 1000 条，
页面最多显示最近 100 条，避免一次 setData 推送全部历史。切后台会主动断开，设备继续运行；
回来后重连补同步。游客项目、开发工具模拟器与 Node mock 不能替代 Android / iOS 真机 BLE。
详见 [微信端说明](miniprogram/README.md)。

## 编译、烧录

推荐 PlatformIO Core 6.2.0；固定 espressif32 8.0.0、ArduinoJson 7.4.2。

```powershell
python -m pip install platformio==6.2.0
pio run -e esp32-s3-n16r8
pio device list
pio run -e esp32-s3-n16r8 --target upload --upload-port COM你的串口号
```

16MB Flash / OPI PSRAM，USB CDC 开启，项目 partitions.csv 提供应用与 LittleFS 分区。
烧录替换现有固件；不要与不兼容的旧文件系统分区混用。首次初始化日志，已有日志损坏时报告故障，
不静默格式化并重用历史序号。

Arduino IDE：运行 `node tools/prepare-arduino.js`，打开生成的 `arduino/pir_buzzer/pir_buzzer.ino`。
需要 ESP32 开发板包 3.x、ArduinoJson 7.4.2 与足够容纳固件/文件系统的匹配分区。
PlatformIO 是推荐的可复现构建路径。

## 触发和记录语义

默认确认 200ms、响铃 3000ms、鸣叫后冷却 1000ms、连续平静 500ms。
这些是软件设置，不是传感器响应速度保证。

1. 上电等待传感器就绪和一段平静，再接受新活动。
2. 一段活动只接受一次；响铃期间合并，不延长、不排队补响。
3. 响铃结束并满足冷却和平静条件后，再接受下一轮。
4. 静音、未布防仍记录有效活动，但不自动发声；停止/静音/撤防会关掉现有输出。
5. 主动“测试蜂鸣器”明确发声、不受静音/布防限制，不计入活动触发次数。

“已启动鸣叫”指固件启动了输出，不证明模块实际发声，也不表示一定响满全部时长。
记录是活动片段，不是人数或每次肢体动作的精确计数。

日志使用 CRC、循环槽位和持久化序号；清空不重置序号。
只有成功持久化的事件进入历史和实时日志通知；队列满、存储故障通过遥测暴露。
断电时尚未完成的最后写入可能丢失。客户端通知不提前推进历史游标，避免漏同步。
连接时由 PC / 手机校时；校时前旧事件保留“启动编号 + 开机相对时间”，不补造日期。

## 检查与性能

```powershell
npm test
pio run -e esp32-s3-n16r8
npm run test:firmware
npm run benchmark
npm run benchmark:firmware
npm run check:generated
npm run check:public
```

原生 C++ 测试需主机 g++，可用 CXX 指定。配置测试使用 PlatformIO 下载的 ArduinoJson 头文件，
也可用 ARDUINOJSON_INCLUDE 指向其 src 目录。GitHub Actions 重跑软件检查和 ESP32 编译。
测试覆盖 UTF-8 分片、超时断连、取消连接、设备确认、微信页面、日志分页有界、
状态机、计时回绕、雷达回读与失败恢复。

主机基准不能代替真实 BLE 速率、Flash 擦写停顿或传感器响应测量。
实际结果及实板验收边界见 [验证说明](docs/validation.md)。

```
src/ include/       固件、纯 C++ 核心、后台存储
pc/                 PC 控制台、USB / BLE / 演示传输
miniprogram/        原生微信端与共享协议
tests/ tools/       测试、基准、Arduino 导出、公开内容检查
docs/protocol.md    USB / BLE 共用 NDJSON 契约
```

参考：[LD2410C](https://www.hlktech.com/cn/Goods-239.html)、
[官方串口协议](https://r0.hlktech.com/download/HLK-LD2410C-24G/1/LD2410C%20%E4%B8%B2%E5%8F%A3%E9%80%9A%E4%BF%A1%E5%8D%8F%E8%AE%AE%20V1.09.pdf)、
[HC-SR505](https://static.rapidonline.com/pdf/78-4110_v1.pdf)、
[ESP32-S3 开发板](https://documentation.espressif.com/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html)。
