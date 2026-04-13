# PlatformIO Station

这是一个并行于旧 `firmware/station` 的新固件目录，用来把当前 ESP32-S3 设备迁到 `PlatformIO + ESP-IDF`，同时接入真实粉尘传感器和 MAX98357A 报警音。

## 当前默认硬件假设

- 开发板: `ESP32-S3-N16R8`
- 粉尘模块: 带 `AO/GND/+5V` 三针输出的 `GP2Y1023` 转接板
- 音频模块: `MAX98357A` I2S 功放板

## 推荐接线

### GP2Y1023 模块

- `+5V` -> `ESP32-S3 5V`
- `GND` -> `ESP32-S3 GND`
- `AO` -> `ESP32-S3 GPIO14`

### MAX98357A 模块

- `VIN` -> `ESP32-S3 5V`
- `GND` -> `ESP32-S3 GND`
- `BCLK` -> `ESP32-S3 GPIO16`
- `LRC/WS` -> `ESP32-S3 GPIO17`
- `DIN` -> `ESP32-S3 GPIO18`
- `SD` -> `3.3V` 先保持常开
- `GAIN` -> 先悬空或按模块默认

喇叭接在 MAX98357A 的输出端子上。

## 上电前提醒

这块 GP2Y1023 转接板看起来已经做了调理电路，但首次上电仍建议先量一下 `AO` 对 `GND` 的电压，确认在你的使用场景里不会超过 `3.3V`。

如果 `AO` 会高于 `3.3V`，请先在 `AO` 和 ESP32 ADC 之间补一个分压。

## 功能

- 通过 ADC 读取 `AO`
- 对模拟值做平滑滤波
- 把电压映射成当前后端可用的 `pollen_value`
- 周期性 POST 到现有后端 `/data`（默认每 2 秒上传一次）
- 浓度达到阈值后，通过 MAX98357A 播放报警音

## 可调参数

可以在 `sdkconfig.defaults` 或 `menuconfig` 里调整：

- Wi-Fi 名称和密码
- 后端 `POST` 地址
- `POST` 上传间隔（`CONFIG_SENSOR_POST_INTERVAL_SEC`，默认 2 秒）
- `AO` 所用 GPIO
- 清洁空气和高浓度的参考电压
- 提示阈值和报警阈值
- I2S 引脚
- 提示音和报警音频率

## 使用方式

```bash
cd firmware/pio_station
pio run
pio run -t upload
pio device monitor
```

如果需要图形配置：

```bash
cd firmware/pio_station
pio run -t menuconfig
```

## 迁移策略

- 旧的 `firmware/station` 保留，继续作为 ESP-IDF 原始版本
- 新的 `firmware/pio_station` 用于真实硬件接入和后续迭代
- 等 PlatformIO 版本稳定后，再决定是否完全切换

## 进一步说明

更详细的接线图和校准流程见：

- `WIRING_AND_CALIBRATION.md`
