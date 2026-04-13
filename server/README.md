# Pollen Escape Backend (MVP)

This service is the first runnable backend for the "Pollen Escape" miniapp flow:

- device uploads pollen data every ~2 seconds
- miniapp starts a match
- backend computes score using smoothing + thresholds + combo
- match auto-ends after 2 consecutive smoothed values below end threshold
- monthly leaderboard is accumulated on server side

## Quick Start

```bash
cd server
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Server default: `http://127.0.0.1:5000`

## Environment Variables

All optional.

- `POLLEN_DB_PATH` (default `%TEMP%\\pollen_escape.db`)
- `POLLEN_START_THRESHOLD` (default `60`)
- `POLLEN_END_THRESHOLD` (default `30`)
- `POLLEN_EFFECTIVE_DROP_T` (default `1`)
- `POLLEN_COMBO_BONUS_3` (default `10`)
- `POLLEN_COMBO_BONUS_5` (default `20`)
- `POLLEN_MAX_DAILY_MATCHES` (default `20`)
- `POLLEN_MATCH_COOLDOWN_SEC` (default `30`)
- `POLLEN_NO_DATA_TIMEOUT_SEC` (default `30`)

## API Overview

### 1) Device Upload

`POST /data`

Body:

```json
{
  "device_id": "esp32-001",
  "ts_ms": 1770000000000,
  "pollen_value": 86.2,
  "seq": 12
}
```

### 2) Query Latest Device Sample

`GET /device/latest?device_id=esp32-001`

### 3) Start Match

`POST /match/start`

Body:

```json
{
  "user_openid": "user_001",
  "nickname": "Alice",
  "device_id": "esp32-001"
}
```

### 4) Poll Match Realtime

`GET /match/realtime?match_id=<match_id>`

Returns current score, combo counters, status, and monthly aggregate once ended.

### 5) Monthly Leaderboard

`GET /leaderboard/monthly?month_key=2026-04&limit=20`

### 6) User Profile

`GET /user/profile?user_openid=user_001&month_key=2026-04`

## Scoring Rule (Current Defaults)

- smoothing: rolling average of up to the latest 3 raw points
- drop value: `last_smoothed - current_smoothed`
- segment score:
  - `drop <= T`: `0`
  - `T < drop <= T+2`: `5`
  - `T+2 < drop <= T+5`: `10`
  - `drop > T+5`: `20`
- combo bonus:
  - every 3 consecutive effective drops: `+10`
  - every 5 consecutive effective drops: `+20`
- auto-end: 2 consecutive smoothed values `< end_threshold`

## Notes

- Final monthly score is server-side accumulated.
- One active match per user and per device is enforced.
- Basic anti-abuse includes daily limit + cooldown + no-data timeout abort.
