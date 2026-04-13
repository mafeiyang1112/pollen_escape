# Wiring And Calibration

This guide has been updated using your uploaded schematic, `LXB-ESP32-S3原理图.pdf`.

## Confirmed Pins From The Schematic

### H1

- `H1-1` -> `3V3`
- `H1-3` -> `GPIO4`
- `H1-8` -> `GPIO16`
- `H1-9` -> `GPIO17`
- `H1-10` -> `GPIO18`

### H2

- `H2-1` -> `GND`

### Pins We Are Intentionally Avoiding

- `H2-2` -> `U0TXD`
- `H2-3` -> `U0RXD`
- `H2-16` -> `GPIO48`
- `H2-19` -> `GPIO20`
- `H2-20` -> `GPIO19`

Reason:

- `U0TXD/U0RXD` are tied to the onboard USB-UART bridge
- `GPIO48` is tied to the onboard `WS2812B`
- `GPIO19/20` are more tightly related to onboard USB-OTG

So the current default set is now `GPIO14/5/4/18`, matching your rewiring plan.

## Default Wiring

### GP2Y1023 3-pin module

| Module pin | Board pin |
|---|---|
| `+5V` | Board `5V / VBUS` |
| `GND` | `H2-1` or any reliable `GND` |
| `AO` | `GPIO14` |

### MAX98357A

| Module pin | Board pin |
|---|---|
| `VIN` | Board `3V3` for your first test, or `5V / VBUS` later if needed |
| `GND` | `H2-1` or any reliable `GND` |
| `BCLK` | `GPIO5` |
| `LRC/WS` | `GPIO4` |
| `DIN` / `SD` data pin | `GPIO18` |
| `GAIN` | Leave floating for now |

The speaker itself connects to the output terminal on the `MAX98357A`, not directly to the ESP32.

## Logic Wiring Diagram

```text
ESP32-S3-N16R8                         GP2Y1023 module
---------------------------------      ----------------
5V / VBUS ---------------------------> +5V
H2-1 / GND --------------------------> GND
GPIO14 ------------------------------> AO


ESP32-S3-N16R8                         MAX98357A
---------------------------------      ----------------
3V3 --------------------------------> VIN
H2-1 / GND --------------------------> GND
GPIO5 -------------------------------> BCLK
GPIO4 -------------------------------> LRC / WS
GPIO18 ------------------------------> DIN
```

## Pre-Power Checklist

1. `GP2Y1023` output into `GPIO14` must still stay at or below `3.3V`
2. All modules must share ground
3. `AO` currently goes to `GPIO14`
4. I2S currently uses `GPIO5 / GPIO4 / GPIO18`
5. `MAX98357A` can start on `3V3` for bring-up, then move to `5V` later if you want more output power

### If You Are Switching From 3.3V Sensor Power To 5V

Use this as your first firmware calibration preset:

```text
CONFIG_SENSOR_CLEAN_AIR_MV=500
CONFIG_SENSOR_DENSE_AIR_MV=2200
CONFIG_SENSOR_SCORE_MAX=120
CONFIG_SENSOR_OUTPUT_INVERTED=n
```

Then re-measure real `raw/filtered` mV values and fine-tune from there.

## Why These GPIOs Were Chosen

The current PlatformIO firmware defaults are:

- `SENSOR_AO_GPIO=14`
- `I2S_BCLK_GPIO=5`
- `I2S_WS_GPIO=4`
- `I2S_DOUT_GPIO=18`

This gives us:

- one exposed ADC-capable input for the dust module
- three simple GPIOs in a clean group for I2S audio
- fewer conflicts with onboard serial, RGB LED, and USB-related pins

## Calibration Goal

This 3-pin `GP2Y1023` board outputs an analog trend voltage, not a naturally precise PM2.5 numeric value.

The firmware maps that voltage into the backend `pollen_value`, so the practical goal is:

- low and stable score in clean air
- clearly higher score in dusty air
- warning and alarm thresholds that feel right in the real world

## Recommended Calibration Flow

### Step 1: connect only the GP2Y1023 first

Do not connect the speaker yet.

Connect:

- `+5V` -> board `5V / VBUS`
- `GND` -> `H2-1`
- `AO` -> `GPIO14`

This keeps the first round of debugging focused on the sensor only.

### Step 2: boot the firmware and watch the serial log

You should see lines like:

```text
sensor raw=xxxmV filtered=xxxmV score=xx.x
```

Focus on:

- `raw`
- `filtered`
- `score`

Quick interpretation:

- if `raw` stays near `3300mV`, suspect overvoltage or wrong wiring
- if `raw` is extremely low and barely changes, re-check power and ground

### Step 3: record the clean-air baseline

Let the sensor stabilize in normal room air for 1 to 2 minutes.

Record:

- the typical `filtered` value in mV
- the rough fluctuation range

Example:

If it sits around `620mV`, set:

```text
CONFIG_SENSOR_CLEAN_AIR_MV=620
```

### Step 4: record a high-density reference

Under safe conditions, expose the sensor to noticeably dustier air and get a practical “high-side” reference value.

Examples:

- light dust disturbance
- paper dust / surface dust disturbance
- near a pollution source, while staying safe

Do not blow water vapor, liquid droplets, or very hot airflow directly into the sensor.

Example:

If `filtered` rises and stabilizes around `1850mV`, set:

```text
CONFIG_SENSOR_DENSE_AIR_MV=1850
```

### Step 5: confirm the direction is correct

After setting baseline and dense-air reference, check:

- clean air -> lower `score`
- dirtier air -> higher `score`

If the direction is reversed, change:

```text
CONFIG_SENSOR_OUTPUT_INVERTED=y
```

### Step 6: tune warning and alarm thresholds

The current thresholds are:

- `CONFIG_SENSOR_WARNING_THRESHOLD`
- `CONFIG_SENSOR_ALARM_THRESHOLD`

Good starting point:

```text
CONFIG_SENSOR_WARNING_THRESHOLD=45
CONFIG_SENSOR_ALARM_THRESHOLD=70
```

Then adjust by feel:

- too sensitive -> raise both
- not sensitive enough -> lower both

### Step 7: connect the MAX98357A

Once the sensor mapping feels right, connect the audio module:

- `VIN` -> board `3V3` for first test
- `GND` -> `H2-1`
- `BCLK` -> `GPIO5`
- `LRC/WS` -> `GPIO4`
- `DIN` -> `GPIO18`

Now verify:

- warning threshold triggers short prompts
- alarm threshold triggers more obvious alarm audio

## Suggested First-Pass Parameters

If you have not measured anything yet, start from:

```text
CONFIG_SENSOR_CLEAN_AIR_MV=500
CONFIG_SENSOR_DENSE_AIR_MV=2200
CONFIG_SENSOR_SCORE_MAX=120
CONFIG_SENSOR_WARNING_THRESHOLD=45
CONFIG_SENSOR_ALARM_THRESHOLD=70
CONFIG_SENSOR_OUTPUT_INVERTED=n
```

## Best Next Tuning Order

1. Measure the real `AO` voltage range
2. Adjust `CLEAN_AIR_MV / DENSE_AIR_MV`
3. Adjust `WARNING_THRESHOLD / ALARM_THRESHOLD`
4. Only then fine-tune the audio frequencies and timing

## Bottom Line

Based on your uploaded schematic, the current recommended wiring is:

- sensor `AO` -> `GPIO14`
- I2S audio -> `H1-8 / H1-9 / H1-10`
- ground -> `H2-1`

This is a stronger, board-specific version of the earlier plan and should be a good base for real hardware bring-up.
