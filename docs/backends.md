# 烧录后端详解

ForgeDeck 把"烧录"抽象成三种任务：`build` / `flash` / `erase`（外加 `clean` 和 `custom`），由 `server/flash.js` 翻译成具体命令。

## 自动选择逻辑

`backend: "auto"` 时按工程特征决定：

```
platformio.ini 存在        → platformio
*.ino 存在                → arduino
Makefile / makefile 存在   → make
其它                       → platformio（并给出明确报错）
```

也可以在界面右上角 `⚙︎ 高级烧录` 里强制指定后端，并填入直烧需要的 `file` 与 `address`。

## PlatformIO

```bash
pio run -d <project> [-e <env>] -t build     # 编译
pio run -d <project> [-e <env>] -t upload --upload-port /dev/ttyUSB0   # 烧录（含编译）
pio run -d <project> -t clean                # 清理
pio run -d <project> -t erase                # 擦除
```

- `env` 来自 `platformio.ini` 的 `[env:xxx]`，界面下拉自动解析
- 未指定 `--upload-port` 时 PlatformIO 自己找板子（多板同插时容易选错，建议显式指定）
- 首次构建会下载工具链，需要网络；之后的离线构建没问题
- 自定义 `pio` 路径：`config.json` → `tools.pio`

## esptool

```bash
esptool.py --port /dev/ttyUSB0 --baud 460800 write_flash -f 0x0 firmware.bin
esptool.py --port /dev/ttyUSB0 erase_flash
```

- `address` 默认 `0x0`；ESP32 的合并镜像通常是 `0x0`，分区表 `0x8000`，app `0x10000`
- CH340/CP210x 用 460800 一般稳定；不稳就降到 115200
- ESP32-S3/C3 的原生 USB 走 `ttyACM`，不需要外部串口芯片

## avrdude

```bash
avrdude -c arduino -p m328p -P /dev/ttyUSB0 -b 115200 -U flash:w:firmware.hex:i
```

- `env` 字段被复用为 MCU 型号（`m328p`、`m2560`…）
- 只烧编译产物 `.hex`；`.bin` 需要 `-U flash:w:file.bin:r` 并指定 `-D`

## st-flash

```bash
st-flash --reset write firmware.bin 0x08000000
```

- 走 ST-Link（SWD），不需要串口
- 权限：`plugdev` 组或 udev 规则；`st-flash` 来自 `stlink-tools`

## dfu-util

```bash
dfu-util -a 0 -s 0x08000000:leave -D firmware.bin
```

- 板子要先进 DFU 模式（BOOT0 拉高 + 复位，或软件跳转）
- 不同芯片的 DFU 地址不同，`0x08000000` 是 STM32 的常见 Flash 基址

## OpenOCD

```bash
openocd -f board/stm32f4discovery.cfg -c "program firmware.elf 0x08000000 verify reset exit"
```

- 需要同时提供 `cfgFile`（`board/...` 或 `interface/...` + `target/...`）
- 适合 ELF + 调试探针（J-Link、CMSIS-DAP、ST-Link 的 OpenOCD 驱动）

## arduino-cli

```bash
arduino-cli compile --build-path .arduino-build <sketch>
arduino-cli upload -p /dev/ttyACM0 --fqbn arduino:avr:uno <sketch>
```

- `env` 字段被复用为 FQBN（`esp32:esp32:esp32`、`arduino:avr:mega`…）
- 首次需要 `arduino-cli core install <平台>`

## picotool / UF2

```bash
picotool load firmware.uf2
```

RP2040 拖拽式烧录在浏览器里不可用（文件系统访问受限），所以走 `picotool`。板子需在 BOOTSEL 模式（USB ID `2e8a:0005`）。

## make

```bash
make flash      # 或 make all / make clean
```

`target` 可在高级烧录里指定（默认 `flash`）。适合 Zephyr（`west flash` 可以包一层 Makefile）、裸机工程。

## 权限与 udev

没有 `/dev/ttyUSB0` 权限时，加组：

```bash
sudo usermod -aG dialout $USER     # 串口
sudo usermod -aG plugdev $USER     # ST-Link / J-Link
```

systemd 用户服务需要显式加组：

```ini
SupplementaryGroups=dialout uucp plugdev
```

Docker 里跑：

```bash
docker run --device=/dev/ttyUSB0 --device=/dev/ttyACM0 ...
```

## 串口监控（非烧录）

```bash
stty -F /dev/ttyUSB0 115200 raw -echo -icrnl -crtscts cs8 -cstopb -parenb
```

ForgeDeck 用的就是这条，然后非阻塞读写该 fd。相比 `screen`/`minicom`，它不抢占终端、可多端观察（同设备仅一个会话，后连的会替换前一个）。

常见波特率：ESP32 日志 `115200`，ESP8266 有些 bootloader 打印 `74880`，高速调试可到 `921600`。
