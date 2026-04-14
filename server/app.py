from __future__ import annotations

import math
import os
import sqlite3
import tempfile
import uuid
import logging
import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

from flask import Flask, current_app, g, has_request_context, jsonify, request, send_from_directory


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.getenv("POLLEN_DB_PATH", os.path.join(tempfile.gettempdir(), "pollen_escape.db"))
WECHAT_CODE2SESSION_URL = "https://api.weixin.qq.com/sns/jscode2session"
LOCAL_ENV_PATH = os.path.join(BASE_DIR, ".env.local")


def load_local_env(path: str) -> None:
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and not os.getenv(key):
                    os.environ[key] = value
    except Exception:
        # Keep startup resilient; auth endpoint will report config issues clearly.
        pass


load_local_env(LOCAL_ENV_PATH)


def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def is_unix_epoch_ms(ts_ms: int, now_value_ms: int | None = None) -> bool:
    if now_value_ms is None:
        now_value_ms = now_ms()
    # Accept timestamps from 2000-01-01 to near-future (7 days ahead).
    return 946684800000 <= ts_ms <= now_value_ms + 7 * 24 * 60 * 60 * 1000


def calc_age_sec(sample_ts_ms: int, received_at_ms: int) -> tuple[int, str]:
    n = now_ms()
    if is_unix_epoch_ms(sample_ts_ms, n):
        return max(0, (n - sample_ts_ms) // 1000), "device_ts_ms"
    return max(0, (n - received_at_ms) // 1000), "server_received_at_ms"


def month_key_from_ms(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m")


def utc_day_start_end(ts_ms: int) -> tuple[int, int]:
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    day_start = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start.replace(hour=23, minute=59, second=59, microsecond=999000)
    return int(day_start.timestamp() * 1000), int(day_end.timestamp() * 1000)


def generate_default_nickname(db=None) -> str:
    """生成一个随机的、唯一的默认昵称
    
    如果db参数传入，会检查昵称是否已存在，确保唯一性
    """
    import random
    
    # 挑战者类型
    titles = ["花粉挑战者", "逃离者", "卫士", "勇士", "冒险家", "探险者", "守护者"]
    # 随机数字或形容词后缀
    adjectives = ["锐锐", "飞快", "无敌", "超能", "光速", "闪电", "狂风"]
    
    # 最多尝试100次确保昵称唯一
    max_attempts = 100
    for attempt in range(max_attempts):
        choice = random.randint(0, 1)
        
        if choice == 0:
            # 返回 "title + 随机数字"
            title = random.choice(titles)
            num = random.randint(100, 9999)
            nickname = f"{title}#{num}"
        else:
            # 返回 "形容词 + title"
            adj = random.choice(adjectives)
            title = random.choice(titles)
            nickname = f"{adj}{title}"
        
        # 如果没有db参数，直接返回（不检查唯一性，用于向后兼容）
        if db is None:
            return nickname
        
        # 检查昵称是否已存在
        existing = db.execute(
            "SELECT openid FROM users WHERE nickname = ?",
            (nickname,)
        ).fetchone()
        
        if not existing:
            # 昵称未被使用，返回
            return nickname
    
    # 如果100次都失败了，返回一个强制唯一的格式
    # (这种情况几乎不可能发生)
    return f"user_{int(datetime.now(timezone.utc).timestamp() * 1000)}"


@dataclass(frozen=True)
class ScoringConfig:
    start_threshold: float
    end_threshold: float
    effective_drop_t: float
    combo_bonus_3: int
    combo_bonus_5: int
    max_daily_matches: int
    match_cooldown_sec: int
    no_data_timeout_sec: int


CFG = ScoringConfig(
    start_threshold=float(os.getenv("POLLEN_START_THRESHOLD", "60")),
    end_threshold=float(os.getenv("POLLEN_END_THRESHOLD", "30")),
    effective_drop_t=float(os.getenv("POLLEN_EFFECTIVE_DROP_T", "1")),
    combo_bonus_3=int(os.getenv("POLLEN_COMBO_BONUS_3", "10")),
    combo_bonus_5=int(os.getenv("POLLEN_COMBO_BONUS_5", "20")),
    max_daily_matches=int(os.getenv("POLLEN_MAX_DAILY_MATCHES", "20")),
    match_cooldown_sec=int(os.getenv("POLLEN_MATCH_COOLDOWN_SEC", "30")),
    no_data_timeout_sec=int(os.getenv("POLLEN_NO_DATA_TIMEOUT_SEC", "30")),
)


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    openid TEXT PRIMARY KEY,
    nickname TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    last_seen_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device_settings (
    device_id TEXT PRIMARY KEY,
    alarm_sound_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sensor_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    pollen_value REAL NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    received_at_ms INTEGER NOT NULL,
    raw_mv INTEGER,
    filtered_mv INTEGER,
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sensor_samples_device_id_id
ON sensor_samples(device_id, id);

CREATE INDEX IF NOT EXISTS idx_sensor_samples_device_id_ts_ms
ON sensor_samples(device_id, ts_ms);

CREATE TABLE IF NOT EXISTS matches (
    match_id TEXT PRIMARY KEY,
    user_openid TEXT NOT NULL,
    device_id TEXT NOT NULL,
    status TEXT NOT NULL,
    start_reason TEXT NOT NULL DEFAULT 'manual',
    end_reason TEXT NOT NULL DEFAULT '',
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    month_key TEXT NOT NULL,
    start_pollen REAL NOT NULL,
    end_pollen REAL,
    current_score INTEGER NOT NULL DEFAULT 0,
    final_score INTEGER NOT NULL DEFAULT 0,
    effective_hits INTEGER NOT NULL DEFAULT 0,
    combo3_count INTEGER NOT NULL DEFAULT 0,
    combo5_count INTEGER NOT NULL DEFAULT 0,
    max_effective_drop REAL NOT NULL DEFAULT 0,
    last_smoothed REAL,
    effective_streak INTEGER NOT NULL DEFAULT 0,
    below_end_streak INTEGER NOT NULL DEFAULT 0,
    last_processed_sensor_id INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (user_openid) REFERENCES users(openid) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_matches_active_device
ON matches(device_id) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_matches_active_user
ON matches(user_openid) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_matches_month_user
ON matches(month_key, user_openid);

CREATE TABLE IF NOT EXISTS match_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    sensor_sample_id INTEGER NOT NULL,
    ts_ms INTEGER NOT NULL,
    raw_value REAL NOT NULL,
    smoothed_value REAL NOT NULL,
    drop_value REAL,
    base_score INTEGER NOT NULL DEFAULT 0,
    combo_bonus INTEGER NOT NULL DEFAULT 0,
    score_gain INTEGER NOT NULL DEFAULT 0,
    total_score_after INTEGER NOT NULL DEFAULT 0,
    is_effective INTEGER NOT NULL DEFAULT 0,
    anomaly_flag TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY (match_id) REFERENCES matches(match_id) ON DELETE CASCADE,
    FOREIGN KEY (sensor_sample_id) REFERENCES sensor_samples(id) ON DELETE CASCADE,
    UNIQUE(match_id, sensor_sample_id)
);

CREATE INDEX IF NOT EXISTS idx_match_samples_match_id_id
ON match_samples(match_id, id);

CREATE TABLE IF NOT EXISTS monthly_scores (
    month_key TEXT NOT NULL,
    user_openid TEXT NOT NULL,
    total_score INTEGER NOT NULL DEFAULT 0,
    valid_matches INTEGER NOT NULL DEFAULT 0,
    best_match_score INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (month_key, user_openid),
    FOREIGN KEY (user_openid) REFERENCES users(openid) ON DELETE CASCADE
);
"""


def init_db() -> None:
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(SCHEMA_SQL)
        conn.commit()
    finally:
        conn.close()


def score_from_drop(drop_value: float | None) -> int:
    if drop_value is None:
        return 0
    t = CFG.effective_drop_t
    if drop_value <= t:
        return 0
    if drop_value <= t + 2:
        return 5
    if drop_value <= t + 5:
        return 10
    return 20


def err(message: str, status: int = 400, *, code: str = "BAD_REQUEST"):
    if has_request_context():
        current_app.logger.warning(
            "API error ip=%s method=%s path=%s code=%s status=%s message=%s",
            request.remote_addr,
            request.method,
            request.path,
            code,
            status,
            message,
        )
    return jsonify({"ok": False, "error": {"code": code, "message": message}}), status


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}


def exchange_wechat_code_for_session(code: str, appid: str, secret: str) -> dict[str, Any]:
    query = urlparse.urlencode(
        {
            "appid": appid,
            "secret": secret,
            "js_code": code,
            "grant_type": "authorization_code",
        }
    )
    url = f"{WECHAT_CODE2SESSION_URL}?{query}"

    try:
        with urlrequest.urlopen(url, timeout=8) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urlerror.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"wechat_http_{e.code}: {detail}") from e
    except urlerror.URLError as e:
        raise RuntimeError(f"wechat_network_error: {e.reason}") from e

    try:
        data = json.loads(body)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"wechat_invalid_json: {body[:120]}") from e

    if not isinstance(data, dict):
        raise RuntimeError("wechat_invalid_response_type")

    return data


def cleanup_orphaned_data(db: sqlite3.Connection) -> None:
    """清理孤立的分数和比赛记录（对应已被删除的用户）"""
    # 删除月度分数中对应已删除用户的记录
    cursor = db.execute("""
        DELETE FROM monthly_scores
        WHERE user_openid NOT IN (SELECT openid FROM users)
    """)
    if cursor.rowcount > 0:
        logging.warning(f"Cleaned up {cursor.rowcount} orphaned monthly_scores records")
    
    # 删除匹配中对应已删除用户的记录（外键约束应该自动处理，但以防万一）
    cursor = db.execute("""
        DELETE FROM matches
        WHERE user_openid NOT IN (SELECT openid FROM users)
    """)
    if cursor.rowcount > 0:
        logging.warning(f"Cleaned up {cursor.rowcount} orphaned matches records")
    
    db.commit()


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


def get_match_summary(db: sqlite3.Connection, match_row: sqlite3.Row) -> dict[str, Any]:
    summary = {
        "match_id": match_row["match_id"],
        "status": match_row["status"],
        "end_reason": match_row["end_reason"],
        "started_at_ms": match_row["started_at_ms"],
        "ended_at_ms": match_row["ended_at_ms"],
        "user_openid": match_row["user_openid"],
        "device_id": match_row["device_id"],
        "month_key": match_row["month_key"],
        "start_pollen": match_row["start_pollen"],
        "end_pollen": match_row["end_pollen"],
        "current_score": match_row["current_score"],
        "final_score": match_row["final_score"],
        "effective_hits": match_row["effective_hits"],
        "combo3_count": match_row["combo3_count"],
        "combo5_count": match_row["combo5_count"],
        "max_effective_drop": match_row["max_effective_drop"],
        "last_smoothed": match_row["last_smoothed"],
        "below_end_streak": match_row["below_end_streak"],
    }

    ms = db.execute(
        """
        SELECT total_score, valid_matches, best_match_score
        FROM monthly_scores
        WHERE month_key = ? AND user_openid = ?
        """,
        (match_row["month_key"], match_row["user_openid"]),
    ).fetchone()

    if ms:
        rank_row = db.execute(
            """
            SELECT 1 + COUNT(*) AS rank_no
            FROM monthly_scores
            WHERE month_key = ?
              AND (
                total_score > ?
                OR (total_score = ? AND best_match_score > ?)
              )
            """,
            (
                match_row["month_key"],
                ms["total_score"],
                ms["total_score"],
                ms["best_match_score"],
            ),
        ).fetchone()
        summary["monthly"] = {
            "total_score": ms["total_score"],
            "valid_matches": ms["valid_matches"],
            "best_match_score": ms["best_match_score"],
            "rank": rank_row["rank_no"] if rank_row else None,
        }
    else:
        summary["monthly"] = {
            "total_score": 0,
            "valid_matches": 0,
            "best_match_score": 0,
            "rank": None,
        }

    return summary


def get_active_match_row(
    db: sqlite3.Connection,
    *,
    device_id: str | None = None,
    user_openid: str | None = None,
) -> sqlite3.Row | None:
    if device_id:
        return db.execute(
            "SELECT * FROM matches WHERE device_id = ? AND status = 'active' LIMIT 1",
            (device_id,),
        ).fetchone()
    if user_openid:
        return db.execute(
            "SELECT * FROM matches WHERE user_openid = ? AND status = 'active' LIMIT 1",
            (user_openid,),
        ).fetchone()
    return None


def finalize_match(db: sqlite3.Connection, match_row: sqlite3.Row) -> None:
    status = str(match_row["status"])
    end_reason = str(match_row["end_reason"] or "").upper()
    final_score = int(match_row["final_score"])

    # Count monthly score when:
    # 1) match finished normally (`ended`), or
    # 2) match was manually stopped with positive score (anti-abuse: score must be > 0).
    if status == "ended":
        pass
    elif status == "aborted" and end_reason.startswith("MANUAL") and final_score > 0:
        pass
    else:
        return

    db.execute(
        """
        INSERT INTO monthly_scores (month_key, user_openid, total_score, valid_matches, best_match_score, updated_at_ms)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(month_key, user_openid) DO UPDATE SET
            total_score = monthly_scores.total_score + excluded.total_score,
            valid_matches = monthly_scores.valid_matches + 1,
            best_match_score = MAX(monthly_scores.best_match_score, excluded.best_match_score),
            updated_at_ms = excluded.updated_at_ms
        """,
        (
            match_row["month_key"],
            match_row["user_openid"],
            final_score,
            final_score,
            now_ms(),
        ),
    )


def ensure_json() -> dict[str, Any] | None:
    if not request.is_json:
        return None
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return None
    return payload


def clamp_limit(value: str | None, default: int = 20, min_v: int = 1, max_v: int = 100) -> int:
    if value is None:
        return default
    try:
        x = int(value)
    except ValueError:
        return default
    return max(min_v, min(max_v, x))


def parse_bool_value(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        if value in (0, 1):
            return bool(value)
        return None
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "on", "yes", "y"}:
            return True
        if normalized in {"0", "false", "off", "no", "n"}:
            return False
    return None


def get_device_alarm_sound_enabled(
    db: sqlite3.Connection,
    device_id: str,
    *,
    default_value: bool = True,
) -> bool:
    row = db.execute(
        "SELECT alarm_sound_enabled FROM device_settings WHERE device_id = ? LIMIT 1",
        (device_id,),
    ).fetchone()
    if row is None:
        return default_value
    return bool(int(row["alarm_sound_enabled"]))


def upsert_device_alarm_sound_enabled(db: sqlite3.Connection, device_id: str, enabled: bool) -> None:
    db.execute(
        """
        INSERT INTO device_settings (device_id, alarm_sound_enabled, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            alarm_sound_enabled = excluded.alarm_sound_enabled,
            updated_at_ms = excluded.updated_at_ms
        """,
        (device_id, 1 if enabled else 0, now_ms()),
    )


def create_app() -> Flask:
    init_db()
    app = Flask(__name__)
    app.config['UPLOAD_FOLDER'] = os.path.join(BASE_DIR, 'uploads')

    # 配置日志级别为 INFO，使数据打印显示
    app.logger.setLevel(logging.INFO)
    
    # 如果还没有handler，添加StreamHandler输出到控制台
    if not app.logger.handlers:
        handler = logging.StreamHandler()
        handler.setLevel(logging.INFO)
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        handler.setFormatter(formatter)
        app.logger.addHandler(handler)

    # 配置静态文件服务
    @app.route('/uploads/<path:filename>')
    def uploaded_file(filename):
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

    @app.teardown_appcontext
    def close_db(_: Any) -> None:
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    @app.post("/auth/wx-login")
    def wx_login():
        payload = ensure_json()
        if payload is None:
            return err("JSON body is required.")

        code = str(payload.get("code", "")).strip()
        if not code:
            return err("`code` is required.")

        appid = str(os.getenv("WECHAT_APPID", "")).strip() or str(os.getenv("WX_APPID", "")).strip()
        secret = str(os.getenv("WECHAT_SECRET", "")).strip() or str(os.getenv("WX_SECRET", "")).strip()
        
        # 开发测试模式：如果没有配置微信参数，使用模拟的 openid
        if not appid or not secret:
            current_app.logger.info("[wx-login] Using mock openid for development")
            mock_openid = "test_openid_" + str(int(time.time()))
            db = get_db()
            t_now = now_ms()
            user = db.execute(
                "SELECT openid, nickname, avatar_url, created_at_ms, updated_at_ms FROM users WHERE openid = ?",
                (mock_openid,),
            ).fetchone()

            if user is None:
                default_nickname = generate_default_nickname(db)
                db.execute(
                    """
                    INSERT INTO users (openid, nickname, avatar_url, created_at_ms, updated_at_ms)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (mock_openid, default_nickname, "", t_now, t_now),
                )
                db.commit()
                user = db.execute(
                    "SELECT openid, nickname, avatar_url, created_at_ms, updated_at_ms FROM users WHERE openid = ?",
                    (mock_openid,),
                ).fetchone()

            return jsonify(
                {
                    "ok": True,
                    "openid": mock_openid,
                    "user": row_to_dict(user),
                }
            )

        try:
            wx_data = exchange_wechat_code_for_session(code, appid, secret)
        except Exception as e:
            current_app.logger.exception("[wx-login] code2session failed")
            return err(f"WeChat login request failed: {e}", status=502, code="WX_REQUEST_FAILED")

        errcode = int(wx_data.get("errcode") or 0)
        if errcode != 0:
            errmsg = str(wx_data.get("errmsg", "")).strip() or "unknown wechat auth error"
            return err(
                f"WeChat auth failed: {errmsg}",
                status=401,
                code=f"WX_AUTH_{errcode}",
            )

        openid = str(wx_data.get("openid", "")).strip()
        if not openid:
            return err("WeChat auth failed: missing openid.", status=502, code="WX_NO_OPENID")

        db = get_db()
        t_now = now_ms()
        user = db.execute(
            "SELECT openid, nickname, avatar_url, created_at_ms, updated_at_ms FROM users WHERE openid = ?",
            (openid,),
        ).fetchone()

        if user is None:
            default_nickname = generate_default_nickname(db)
            db.execute(
                """
                INSERT INTO users (openid, nickname, avatar_url, created_at_ms, updated_at_ms)
                VALUES (?, ?, ?, ?, ?)
                """,
                (openid, default_nickname, "", t_now, t_now),
            )
            db.commit()
            user = db.execute(
                "SELECT openid, nickname, avatar_url, created_at_ms, updated_at_ms FROM users WHERE openid = ?",
                (openid,),
            ).fetchone()

        return jsonify(
            {
                "ok": True,
                "openid": openid,
                "user": row_to_dict(user),
            }
        )

    @app.post("/user/update")
    def user_update():
        payload = ensure_json()
        if payload is None:
            return err("JSON body is required.")

        user_openid = str(payload.get("user_openid", "")).strip()
        nickname = str(payload.get("nickname", "")).strip()
        avatar_url = str(payload.get("avatar_url", "")).strip()
        
        # 只接受有效的远程头像 URL（http:// 或 https:// 开头）
        if avatar_url and not (avatar_url.startswith("http://") or avatar_url.startswith("https://")):
            avatar_url = ""

        if not user_openid:
            return err("`user_openid` is required.")

        db = get_db()
        t_now = now_ms()
        
        # 如果用户要更新昵称，检查该昵称是否已被其他用户使用（唯一性检查）
        if nickname:
            existing_user = db.execute(
                "SELECT openid FROM users WHERE nickname = ? AND openid != ?",
                (nickname, user_openid)
            ).fetchone()
            
            if existing_user:
                return err(
                    f"昵称'{nickname}'已被其他用户使用，请选择其他昵称", 
                    status=409, 
                    code="NICKNAME_ALREADY_TAKEN"
                )
        
        existing_self = db.execute(
            "SELECT openid, nickname, avatar_url FROM users WHERE openid = ?",
            (user_openid,),
        ).fetchone()

        if existing_self is None:
            # 首次更新时如果用户还不存在，直接创建，避免更新空行。
            final_nickname = nickname if nickname else generate_default_nickname(db)
            db.execute(
                """
                INSERT INTO users (openid, nickname, avatar_url, created_at_ms, updated_at_ms)
                VALUES (?, ?, ?, ?, ?)
                """,
                (user_openid, final_nickname, avatar_url, t_now, t_now),
            )
        elif nickname or avatar_url:
            db.execute(
                """
                UPDATE users
                SET nickname = CASE WHEN ? != '' THEN ? ELSE nickname END,
                    avatar_url = CASE WHEN ? != '' THEN ? ELSE avatar_url END,
                    updated_at_ms = ?
                WHERE openid = ?
                """,
                (nickname, nickname, avatar_url, avatar_url, t_now, user_openid),
            )
        db.commit()

        user = db.execute(
            "SELECT openid, nickname, avatar_url FROM users WHERE openid = ?",
            (user_openid,),
        ).fetchone()

        return jsonify({"ok": True, "user": row_to_dict(user)})

    @app.post("/upload/avatar")
    def upload_avatar():
        """上传头像文件"""
        if 'file' not in request.files:
            return err("No file part", 400, code="NO_FILE")
        
        file = request.files['file']
        if file.filename == '':
            return err("No selected file", 400, code="NO_FILE_SELECTED")
        
        # 生成唯一文件名
        import uuid
        ext = file.filename.rsplit('.', 1)[1].lower() if '.' in file.filename else 'jpg'
        filename = f"avatar_{uuid.uuid4()}.{ext}"
        
        # 确保上传目录存在
        upload_dir = os.path.join(BASE_DIR, 'uploads', 'avatars')
        os.makedirs(upload_dir, exist_ok=True)
        
        # 保存文件
        file_path = os.path.join(upload_dir, filename)
        file.save(file_path)
        
        # 生成访问URL（优先使用反向代理透传的协议/主机，避免返回 http 链接）
        forwarded_proto = (request.headers.get('X-Forwarded-Proto') or '').split(',')[0].strip()
        forwarded_host = (request.headers.get('X-Forwarded-Host') or '').split(',')[0].strip()
        scheme = forwarded_proto or request.scheme or 'http'
        host = forwarded_host or request.host
        avatar_url = f"{scheme}://{host}/uploads/avatars/{filename}"
        
        return jsonify({
            "ok": True,
            "avatar_url": avatar_url
        })

    @app.get("/healthz")
    def healthz():
        return jsonify(
            {
                "ok": True,
                "service": "pollen-escape-server",
                "time_ms": now_ms(),
                "config": {
                    "start_threshold": CFG.start_threshold,
                    "end_threshold": CFG.end_threshold,
                    "effective_drop_t": CFG.effective_drop_t,
                },
            }
        )

    @app.get("/")
    def index():
        db = get_db()
        latest_samples = db.execute(
            """
            SELECT id, device_id, ts_ms, pollen_value, seq, received_at_ms
            FROM sensor_samples
            ORDER BY id DESC
            LIMIT 10
            """
        ).fetchall()

        active_match_count = db.execute(
            "SELECT COUNT(*) AS c FROM matches WHERE status = 'active'"
        ).fetchone()["c"]

        ended_match_count = db.execute(
            "SELECT COUNT(*) AS c FROM matches WHERE status = 'ended'"
        ).fetchone()["c"]

        devices_online_1min = db.execute(
            """
            SELECT COUNT(*) AS c
            FROM devices
            WHERE last_seen_ms >= ?
            """,
            (now_ms() - 60_000,),
        ).fetchone()["c"]

        return jsonify(
            {
                "ok": True,
                "service": "pollen-escape-server",
                "time_ms": now_ms(),
                "summary": {
                    "devices_online_last_1min": devices_online_1min,
                    "active_matches": active_match_count,
                    "ended_matches": ended_match_count,
                },
                "latest_samples": [row_to_dict(x) for x in latest_samples],
                "tips": {
                    "healthz": "/healthz",
                    "latest_by_device": "/device/latest?device_id=esp32-001",
                    "device_sound": "POST /device/sound",
                    "match_samples": "/match/samples?match_id=<match_id>&limit=60",
                    "leaderboard": "/leaderboard/monthly",
                },
            }
        )

    @app.post("/data")
    def ingest_data():
        payload = ensure_json()
        if payload is None:
            return err("JSON body is required.")

        device_id = str(payload.get("device_id", "")).strip()
        if not device_id:
            return err("`device_id` is required.")

        try:
            pollen_value = float(payload.get("pollen_value"))
        except (TypeError, ValueError):
            return err("`pollen_value` must be a number.")
        if not math.isfinite(pollen_value):
            return err("`pollen_value` must be finite.")

        # 新增：处理 raw_mv 和 filtered_mv 字段
        raw_mv = None
        filtered_mv = None
        if "raw_mv" in payload:
            try:
                raw_mv = int(payload.get("raw_mv"))
            except (TypeError, ValueError):
                pass
        if "filtered_mv" in payload:
            try:
                filtered_mv = int(payload.get("filtered_mv"))
            except (TypeError, ValueError):
                pass

        ts_ms_raw = payload.get("ts_ms", now_ms())
        try:
            ts_ms = int(ts_ms_raw)
        except (TypeError, ValueError):
            return err("`ts_ms` must be an integer timestamp in milliseconds.")

        seq_raw = payload.get("seq", 0)
        try:
            seq = int(seq_raw)
        except (TypeError, ValueError):
            return err("`seq` must be an integer.")

        db = get_db()
        t_now = now_ms()
        db.execute(
            """
            INSERT INTO devices (device_id, last_seen_ms, created_at_ms, updated_at_ms)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                last_seen_ms = excluded.last_seen_ms,
                updated_at_ms = excluded.updated_at_ms
            """,
            (device_id, t_now, t_now, t_now),
        )
        cur = db.execute(
            """
            INSERT INTO sensor_samples (device_id, ts_ms, pollen_value, seq, received_at_ms, raw_mv, filtered_mv)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (device_id, ts_ms, pollen_value, seq, t_now, raw_mv, filtered_mv),
        )
        alarm_sound_enabled = get_device_alarm_sound_enabled(db, device_id, default_value=True)
        db.commit()

        current_app.logger.info(
            "DATA ok ip=%s device_id=%s ts_ms=%s pollen_value=%.2f raw_mv=%s filtered_mv=%s seq=%s sample_id=%s",
            request.remote_addr,
            device_id,
            ts_ms,
            pollen_value,
            raw_mv or "-" ,
            filtered_mv or "-" ,
            seq,
            cur.lastrowid,
        )

        return (
            jsonify(
                {
                    "ok": True,
                    "sample": {
                        "id": cur.lastrowid,
                        "device_id": device_id,
                        "ts_ms": ts_ms,
                        "pollen_value": pollen_value,
                        "raw_mv": raw_mv,
                        "filtered_mv": filtered_mv,
                        "seq": seq,
                    },
                    "controls": {
                        "alarm_sound_enabled": alarm_sound_enabled,
                    },
                }
            ),
            201,
        )

    @app.post("/device/sound")
    def set_device_sound():
        payload = ensure_json()
        if payload is None:
            return err("JSON body is required.")

        device_id = str(payload.get("device_id", "")).strip()
        if not device_id:
            return err("`device_id` is required.")

        raw_enabled = payload.get("sound_enabled", payload.get("alarm_sound_enabled"))
        sound_enabled = parse_bool_value(raw_enabled)
        if sound_enabled is None:
            return err("`sound_enabled` must be boolean (true/false).")

        db = get_db()
        upsert_device_alarm_sound_enabled(db, device_id, sound_enabled)
        db.commit()

        return jsonify(
            {
                "ok": True,
                "device_id": device_id,
                "alarm_sound_enabled": sound_enabled,
            }
        )

    @app.get("/device/latest")
    def device_latest():
        device_id = request.args.get("device_id", "").strip()
        if not device_id:
            return err("`device_id` query parameter is required.")

        db = get_db()
        row = db.execute(
            """
            SELECT id, device_id, ts_ms, pollen_value, seq, received_at_ms, raw_mv, filtered_mv
            FROM sensor_samples
            WHERE device_id = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (device_id,),
        ).fetchone()

        if row is None:
            return err(f"no samples for device `{device_id}`", 404, code="NOT_FOUND")

        age_sec, age_source = calc_age_sec(int(row["ts_ms"]), int(row["received_at_ms"]))
        alarm_sound_enabled = get_device_alarm_sound_enabled(db, device_id, default_value=True)
        return jsonify(
            {
                "ok": True,
                "latest": {
                    **row_to_dict(row),
                    "age_sec": age_sec,
                    "age_source": age_source,
                },
                "controls": {
                    "alarm_sound_enabled": alarm_sound_enabled,
                },
            }
        )

    @app.post("/match/start")
    def match_start():
        payload = ensure_json()
        if payload is None:
            return err("JSON body is required.")

        user_openid = str(payload.get("user_openid", "")).strip()
        device_id = str(payload.get("device_id", "")).strip()
        nickname = str(payload.get("nickname", "")).strip()
        avatar_url = str(payload.get("avatar_url", "")).strip()

        if not user_openid:
            return err("`user_openid` is required.")
        if not device_id:
            return err("`device_id` is required.")

        db = get_db()
        t_now = now_ms()
        month_key = month_key_from_ms(t_now)

        active_device = get_active_match_row(db, device_id=device_id)
        if active_device:
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": {
                            "code": "ACTIVE_MATCH_EXISTS",
                            "message": "this device is already in an active match.",
                        },
                        "active_match": {
                            "match_id": active_device["match_id"],
                            "device_id": active_device["device_id"],
                            "user_openid": active_device["user_openid"],
                            "status": active_device["status"],
                            "started_at_ms": active_device["started_at_ms"],
                        },
                    }
                ),
                409,
            )

        active_user = get_active_match_row(db, user_openid=user_openid)
        if active_user:
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": {
                            "code": "ACTIVE_MATCH_EXISTS",
                            "message": "this user already has an active match.",
                        },
                        "active_match": {
                            "match_id": active_user["match_id"],
                            "device_id": active_user["device_id"],
                            "user_openid": active_user["user_openid"],
                            "status": active_user["status"],
                            "started_at_ms": active_user["started_at_ms"],
                        },
                    }
                ),
                409,
            )

        start_day_ms, end_day_ms = utc_day_start_end(t_now)
        daily_cnt = db.execute(
            """
            SELECT COUNT(*) AS c
            FROM matches
            WHERE user_openid = ?
              AND started_at_ms BETWEEN ? AND ?
            """,
            (user_openid, start_day_ms, end_day_ms),
        ).fetchone()["c"]
        if daily_cnt >= CFG.max_daily_matches:
            return err("daily match limit reached.", 429, code="DAILY_LIMIT_REACHED")

        last_match = db.execute(
            """
            SELECT ended_at_ms
            FROM matches
            WHERE user_openid = ? AND ended_at_ms IS NOT NULL
            ORDER BY ended_at_ms DESC
            LIMIT 1
            """,
            (user_openid,),
        ).fetchone()
        if last_match is not None:
            elapsed_sec = (t_now - int(last_match["ended_at_ms"])) // 1000
            if elapsed_sec < CFG.match_cooldown_sec:
                retry_after_sec = CFG.match_cooldown_sec - elapsed_sec
                return (
                    jsonify(
                        {
                            "ok": False,
                            "error": {
                                "code": "COOLDOWN_NOT_REACHED",
                                "message": f"match cooldown not reached, wait {retry_after_sec} sec.",
                                "retry_after_sec": retry_after_sec,
                            },
                        }
                    ),
                    429,
                )

        latest = db.execute(
            """
            SELECT id, ts_ms, pollen_value, seq, received_at_ms
            FROM sensor_samples
            WHERE device_id = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (device_id,),
        ).fetchone()
        if latest is None:
            return err("device has no data yet; cannot start match.", 400, code="NO_DEVICE_DATA")

        latest_age_sec, _ = calc_age_sec(int(latest["ts_ms"]), int(latest["received_at_ms"]))
        if latest_age_sec >= CFG.no_data_timeout_sec:
            return err(
                f"device latest data is stale ({latest_age_sec}s old), waiting for fresh sensor data.",
                400,
                code="STALE_DEVICE_DATA",
            )

        if float(latest["pollen_value"]) < CFG.start_threshold:
            return err(
                f"start pollen {latest['pollen_value']} is lower than threshold {CFG.start_threshold}.",
                400,
                code="START_THRESHOLD_NOT_MET",
            )

        # 只在提供了有效昵称或用户不存在时才更新用户信息
        # 避免在 match/start 时因为未传昵称而把已有的昵称覆盖为空
        existing_user = db.execute("SELECT nickname, avatar_url FROM users WHERE openid = ?", (user_openid,)).fetchone()
        
        if not existing_user:
            # 用户不存在，使用传入的昵称或生成默认昵称
            final_nickname = nickname if nickname else generate_default_nickname(db)
            final_avatar = avatar_url
            db.execute(
                """
                INSERT INTO users (openid, nickname, avatar_url, created_at_ms, updated_at_ms)
                VALUES (?, ?, ?, ?, ?)
                """,
                (user_openid, final_nickname, final_avatar, t_now, t_now),
            )
        else:
            # 用户已存在，只有在提供了非空昵称/头像时才更新
            if nickname or avatar_url:
                db.execute(
                    """
                    UPDATE users
                    SET nickname = CASE WHEN ? != '' THEN ? ELSE nickname END,
                        avatar_url = CASE WHEN ? != '' THEN ? ELSE avatar_url END,
                        updated_at_ms = ?
                    WHERE openid = ?
                    """,
                    (nickname, nickname, avatar_url, avatar_url, t_now, user_openid),
                )

        match_id = uuid.uuid4().hex
        db.execute(
            """
            INSERT INTO matches (
                match_id, user_openid, device_id, status, start_reason, end_reason,
                started_at_ms, ended_at_ms, month_key, start_pollen, end_pollen,
                current_score, final_score, effective_hits, combo3_count, combo5_count,
                max_effective_drop, last_smoothed, effective_streak, below_end_streak,
                last_processed_sensor_id, created_at_ms, updated_at_ms
            )
            VALUES (?, ?, ?, 'active', 'manual', '', ?, NULL, ?, ?, NULL, 0, 0, 0, 0, 0, 0, NULL, 0, 0, ?, ?, ?)
            """,
            (
                match_id,
                user_openid,
                device_id,
                t_now,
                month_key,
                float(latest["pollen_value"]),
                int(latest["id"]),
                t_now,
                t_now,
            ),
        )
        db.commit()

        return (
            jsonify(
                {
                    "ok": True,
                    "match": {
                        "match_id": match_id,
                        "status": "active",
                        "user_openid": user_openid,
                        "device_id": device_id,
                        "started_at_ms": t_now,
                        "start_pollen": float(latest["pollen_value"]),
                        "start_threshold": CFG.start_threshold,
                        "end_threshold": CFG.end_threshold,
                        "effective_drop_t": CFG.effective_drop_t,
                    },
                }
            ),
            201,
        )

    @app.get("/match/active")
    def match_active():
        device_id = request.args.get("device_id", "").strip()
        user_openid = request.args.get("user_openid", "").strip()
        if not device_id and not user_openid:
            return err("`device_id` or `user_openid` is required.", 400, code="BAD_REQUEST")

        db = get_db()
        row = get_active_match_row(db, device_id=device_id, user_openid=None)
        if row is None and user_openid:
            row = get_active_match_row(db, device_id=None, user_openid=user_openid)

        if row is None:
            return jsonify({"ok": True, "active_match": None})

        return jsonify(
            {
                "ok": True,
                "active_match": {
                    "match_id": row["match_id"],
                    "device_id": row["device_id"],
                    "user_openid": row["user_openid"],
                    "status": row["status"],
                    "started_at_ms": row["started_at_ms"],
                },
            }
        )

    @app.post("/match/stop")
    def match_stop():
        payload = ensure_json()
        if payload is None:
            return err("JSON body is required.")

        match_id = str(payload.get("match_id", "")).strip()
        device_id = str(payload.get("device_id", "")).strip()
        user_openid = str(payload.get("user_openid", "")).strip()
        end_reason = str(payload.get("end_reason", "MANUAL_STOP")).strip() or "MANUAL_STOP"

        db = get_db()
        row = None
        if match_id:
            row = db.execute(
                "SELECT * FROM matches WHERE match_id = ? AND status = 'active' LIMIT 1",
                (match_id,),
            ).fetchone()
        if row is None and device_id:
            row = get_active_match_row(db, device_id=device_id)
        if row is None and user_openid:
            row = get_active_match_row(db, user_openid=user_openid)
        if row is None:
            return err("active match not found.", 404, code="NOT_FOUND")

        stop_time = now_ms()
        db.execute(
            """
            UPDATE matches
            SET status = 'aborted',
                end_reason = ?,
                ended_at_ms = ?,
                final_score = current_score,
                end_pollen = COALESCE(end_pollen, start_pollen),
                updated_at_ms = ?
            WHERE match_id = ?
            """,
            (end_reason, stop_time, stop_time, row["match_id"]),
        )

        refreshed = db.execute("SELECT * FROM matches WHERE match_id = ?", (row["match_id"],)).fetchone()
        if refreshed:
            finalize_match(db, refreshed)
            refreshed = db.execute("SELECT * FROM matches WHERE match_id = ?", (row["match_id"],)).fetchone()
        db.commit()
        return jsonify({"ok": True, "match": get_match_summary(db, refreshed)})

    @app.get("/match/realtime")
    def match_realtime():
        match_id = request.args.get("match_id", "").strip()
        if not match_id:
            return err("`match_id` query parameter is required.")

        db = get_db()
        match_row = db.execute(
            "SELECT * FROM matches WHERE match_id = ? LIMIT 1",
            (match_id,),
        ).fetchone()
        if match_row is None:
            return err(f"match `{match_id}` not found.", 404, code="NOT_FOUND")

        if match_row["status"] != "active":
            return jsonify({"ok": True, "match": get_match_summary(db, match_row), "processed_samples": 0})

        device_id = str(match_row["device_id"])
        new_samples = db.execute(
            """
            SELECT id, ts_ms, pollen_value, seq
            FROM sensor_samples
            WHERE device_id = ? AND id > ?
            ORDER BY id ASC
            """,
            (device_id, int(match_row["last_processed_sensor_id"])),
        ).fetchall()

        if not new_samples:
            latest_sensor = db.execute(
                """
                SELECT ts_ms, received_at_ms
                FROM sensor_samples
                WHERE device_id = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (device_id,),
            ).fetchone()
            if latest_sensor is not None:
                idle_sec, _ = calc_age_sec(int(latest_sensor["ts_ms"]), int(latest_sensor["received_at_ms"]))
                if idle_sec >= CFG.no_data_timeout_sec:
                    end_time = now_ms()
                    db.execute(
                        """
                        UPDATE matches
                        SET status = 'aborted',
                            end_reason = 'NO_DATA_TIMEOUT',
                            ended_at_ms = ?,
                            final_score = current_score,
                            end_pollen = COALESCE(end_pollen, start_pollen),
                            updated_at_ms = ?
                        WHERE match_id = ?
                        """,
                        (end_time, end_time, match_id),
                    )
                    db.commit()
                    refreshed = db.execute(
                        "SELECT * FROM matches WHERE match_id = ?",
                        (match_id,),
                    ).fetchone()
                    return jsonify(
                        {
                            "ok": True,
                            "match": get_match_summary(db, refreshed),
                            "processed_samples": 0,
                            "waiting_for_data": False,
                        }
                    )

            return jsonify(
                {
                    "ok": True,
                    "match": get_match_summary(db, match_row),
                    "processed_samples": 0,
                    "waiting_for_data": True,
                }
            )

        raw_window = [
            float(x["raw_value"])
            for x in db.execute(
                """
                SELECT raw_value
                FROM match_samples
                WHERE match_id = ?
                ORDER BY id DESC
                LIMIT 2
                """,
                (match_id,),
            ).fetchall()
        ][::-1]

        current_score = int(match_row["current_score"])
        effective_hits = int(match_row["effective_hits"])
        combo3_count = int(match_row["combo3_count"])
        combo5_count = int(match_row["combo5_count"])
        max_effective_drop = float(match_row["max_effective_drop"])
        effective_streak = int(match_row["effective_streak"])
        below_end_streak = int(match_row["below_end_streak"])
        last_smoothed = float(match_row["last_smoothed"]) if match_row["last_smoothed"] is not None else None

        status = "active"
        end_reason = ""
        ended_at_ms = None
        end_pollen = None
        processed = 0

        for sample in new_samples:
            processed += 1
            sensor_id = int(sample["id"])
            ts_ms = int(sample["ts_ms"])
            raw_value = float(sample["pollen_value"])

            raw_window.append(raw_value)
            if len(raw_window) > 3:
                raw_window.pop(0)
            smoothed = sum(raw_window) / len(raw_window)

            drop_value = None if last_smoothed is None else (last_smoothed - smoothed)
            base_score = score_from_drop(drop_value)
            is_effective = 1 if base_score > 0 else 0

            combo_bonus = 0
            if is_effective:
                effective_streak += 1
                effective_hits += 1
                if drop_value is not None:
                    max_effective_drop = max(max_effective_drop, drop_value)
                if effective_streak % 5 == 0:
                    combo_bonus = CFG.combo_bonus_5
                    combo5_count += 1
                elif effective_streak % 3 == 0:
                    combo_bonus = CFG.combo_bonus_3
                    combo3_count += 1
            else:
                effective_streak = 0

            score_gain = base_score + combo_bonus
            current_score += score_gain

            if smoothed < CFG.end_threshold:
                below_end_streak += 1
            else:
                below_end_streak = 0

            db.execute(
                """
                INSERT INTO match_samples (
                    match_id, sensor_sample_id, ts_ms, raw_value, smoothed_value, drop_value,
                    base_score, combo_bonus, score_gain, total_score_after, is_effective, anomaly_flag, created_at_ms
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
                """,
                (
                    match_id,
                    sensor_id,
                    ts_ms,
                    raw_value,
                    smoothed,
                    drop_value,
                    base_score,
                    combo_bonus,
                    score_gain,
                    current_score,
                    is_effective,
                    now_ms(),
                ),
            )

            last_smoothed = smoothed
            end_pollen = raw_value
            match_row = dict(match_row)
            match_row["last_processed_sensor_id"] = sensor_id

            if below_end_streak >= 2:
                status = "ended"
                end_reason = "LOW_POLLEN_REACHED"
                ended_at_ms = ts_ms
                break

        update_now = now_ms()
        db.execute(
            """
            UPDATE matches
            SET status = ?,
                end_reason = ?,
                ended_at_ms = ?,
                end_pollen = COALESCE(?, end_pollen),
                current_score = ?,
                final_score = CASE WHEN ? = 'active' THEN final_score ELSE ? END,
                effective_hits = ?,
                combo3_count = ?,
                combo5_count = ?,
                max_effective_drop = ?,
                last_smoothed = ?,
                effective_streak = ?,
                below_end_streak = ?,
                last_processed_sensor_id = ?,
                updated_at_ms = ?
            WHERE match_id = ?
            """,
            (
                status,
                end_reason,
                ended_at_ms,
                end_pollen,
                current_score,
                status,
                current_score,
                effective_hits,
                combo3_count,
                combo5_count,
                max_effective_drop,
                last_smoothed,
                effective_streak,
                below_end_streak,
                int(new_samples[processed - 1]["id"]),
                update_now,
                match_id,
            ),
        )

        refreshed = db.execute(
            "SELECT * FROM matches WHERE match_id = ?",
            (match_id,),
        ).fetchone()
        if refreshed and refreshed["status"] == "ended":
            finalize_match(db, refreshed)
            refreshed = db.execute(
                "SELECT * FROM matches WHERE match_id = ?",
                (match_id,),
            ).fetchone()

        db.commit()
        return jsonify(
            {
                "ok": True,
                "match": get_match_summary(db, refreshed),
                "processed_samples": processed,
                "waiting_for_data": False,
            }
        )

    @app.get("/match/samples")
    def match_samples():
        match_id = request.args.get("match_id", "").strip()
        if not match_id:
            return err("`match_id` query parameter is required.")
        limit = clamp_limit(request.args.get("limit"), default=60, min_v=5, max_v=300)

        db = get_db()
        match_row = db.execute(
            "SELECT match_id, status, device_id, started_at_ms, ended_at_ms FROM matches WHERE match_id = ? LIMIT 1",
            (match_id,),
        ).fetchone()
        if match_row is None:
            return err(f"match `{match_id}` not found.", 404, code="NOT_FOUND")

        rows = db.execute(
            """
            SELECT ts_ms, raw_value, smoothed_value, drop_value, score_gain, total_score_after, is_effective
            FROM match_samples
            WHERE match_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (match_id, limit),
        ).fetchall()
        samples = [row_to_dict(x) for x in rows][::-1]

        return jsonify(
            {
                "ok": True,
                "match": row_to_dict(match_row),
                "samples": samples,
            }
        )

    @app.get("/leaderboard/monthly")
    def monthly_leaderboard():
        month_key = request.args.get("month_key")
        if not month_key:
            month_key = month_key_from_ms(now_ms())
        limit = clamp_limit(request.args.get("limit"), default=20)

        db = get_db()
        # 清理孤立的分数记录，确保排行榜始终干净
        cleanup_orphaned_data(db)
        
        rows = db.execute(
            """
            SELECT
                m.user_openid,
                COALESCE(u.nickname, '') AS nickname,
                COALESCE(u.avatar_url, '') AS avatar_url,
                m.total_score,
                m.valid_matches,
                m.best_match_score
            FROM monthly_scores m
            LEFT JOIN users u ON u.openid = m.user_openid
            WHERE m.month_key = ?
            ORDER BY m.total_score DESC, m.best_match_score DESC, m.user_openid ASC
            LIMIT ?
            """,
            (month_key, limit),
        ).fetchall()

        data = []
        rank = 1
        for row in rows:
            item = row_to_dict(row) or {}
            item["rank"] = rank
            data.append(item)
            rank += 1

        return jsonify({"ok": True, "month_key": month_key, "leaderboard": data})

    @app.get("/user/profile")
    def user_profile():
        user_openid = request.args.get("user_openid", "").strip()
        if not user_openid:
            return err("`user_openid` query parameter is required.")

        month_key = request.args.get("month_key")
        if not month_key:
            month_key = month_key_from_ms(now_ms())

        db = get_db()
        user = db.execute(
            "SELECT openid, nickname, avatar_url, created_at_ms, updated_at_ms FROM users WHERE openid = ?",
            (user_openid,),
        ).fetchone()
        
        if user is None:
            # Auto-create user if not found (lazy registration)
            t_now = now_ms()
            # 生成唯一的昵称
            default_nickname = generate_default_nickname(db)
            db.execute(
                """
                INSERT INTO users (openid, nickname, avatar_url, created_at_ms, updated_at_ms)
                VALUES (?, ?, ?, ?, ?)
                """,
                (user_openid, default_nickname, "", t_now, t_now),
            )
            db.commit()
            current_app.logger.info(f"[user-profile] Created new user: openid={user_openid}, nickname={default_nickname}")
            user = db.execute(
                "SELECT openid, nickname, avatar_url, created_at_ms, updated_at_ms FROM users WHERE openid = ?",
                (user_openid,),
            ).fetchone()

        monthly = db.execute(
            """
            SELECT total_score, valid_matches, best_match_score
            FROM monthly_scores
            WHERE month_key = ? AND user_openid = ?
            """,
            (month_key, user_openid),
        ).fetchone()
        monthly_payload = row_to_dict(monthly) or {
            "total_score": 0,
            "valid_matches": 0,
            "best_match_score": 0,
            "rank": None,
        }
        if monthly is not None:
            rank_row = db.execute(
                """
                SELECT 1 + COUNT(*) AS rank_no
                FROM monthly_scores
                WHERE month_key = ?
                  AND (
                    total_score > ?
                    OR (total_score = ? AND best_match_score > ?)
                  )
                """,
                (
                    month_key,
                    monthly["total_score"],
                    monthly["total_score"],
                    monthly["best_match_score"],
                ),
            ).fetchone()
            monthly_payload["rank"] = rank_row["rank_no"] if rank_row else None

        recent_matches = db.execute(
            """
            SELECT
                match_id, status, started_at_ms, ended_at_ms, final_score, end_reason, device_id
            FROM matches
            WHERE user_openid = ?
            ORDER BY started_at_ms DESC
            LIMIT 10
            """,
            (user_openid,),
        ).fetchall()

        return jsonify(
            {
                "ok": True,
                "user": row_to_dict(user),
                "month_key": month_key,
                "monthly": monthly_payload,
                "recent_matches": [row_to_dict(x) for x in recent_matches],
            }
        )

    return app


app = create_app()


if __name__ == "__main__":
    # 本地开发环境：使用 Flask 自带服务器
    port = int(os.getenv("PORT", "5000"))
    debug_mode = os.getenv("DEBUG", "False").lower() in ("true", "1", "yes")
    app.run(host="0.0.0.0", port=port, debug=debug_mode)
