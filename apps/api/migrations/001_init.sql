-- Alertly initial schema. Conventions:
--   ids are BIGINT UNSIGNED AUTO_INCREMENT (exposed publicly as prefixed base62, e.g. ntf_4c92)
--   times are DATETIME(3) in UTC (millisecond precision)
--   every foreign key column is indexed (InnoDB requires it, and joins need it)

CREATE TABLE users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(255)    NOT NULL,
  password_hash VARCHAR(255)    NOT NULL,
  name          VARCHAR(100)    NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE api_keys (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(100)    NOT NULL,
  key_prefix   CHAR(12)        NOT NULL,
  key_hash     CHAR(64)        NOT NULL,
  last_used_at DATETIME(3)     NULL,
  revoked_at   DATETIME(3)     NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_keys_hash (key_hash),
  KEY idx_api_keys_user (user_id),
  CONSTRAINT fk_api_keys_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Channels are soft-deleted (deleted_at) so the delivery history that points at them survives.
CREATE TABLE channels (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  type        ENUM('email','webhook','telegram') NOT NULL,
  name        VARCHAR(100)    NOT NULL,
  config      JSON            NOT NULL,
  secret_enc  VARBINARY(512)  NULL,
  status      ENUM('active','disabled') NOT NULL DEFAULT 'active',
  verified_at DATETIME(3)     NULL,
  deleted_at  DATETIME(3)     NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_channels_user (user_id, deleted_at, status),
  CONSTRAINT fk_channels_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- UNIQUE (user_id, idempotency_key) is what makes creation idempotent. NULL keys never
-- collide in a MySQL unique index, so requests without a key are simply not deduplicated.
CREATE TABLE notifications (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(128)    NULL,
  request_hash    CHAR(64)        NULL,
  source          ENUM('api','alert','test') NOT NULL,
  title           VARCHAR(200)    NOT NULL,
  body            TEXT            NOT NULL,
  data            JSON            NULL,
  priority        ENUM('normal','high') NOT NULL DEFAULT 'normal',
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_notifications_idem (user_id, idempotency_key),
  KEY idx_notifications_user_created (user_id, created_at, id),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The delivery queue. One row per (notification, channel).
--   attempt_count  attempts in the current round; drives backoff and max_attempts.
--                  A manual retry starts a new round by resetting it to 0.
--   total_attempts attempts ever; numbers the attempt log so it never repeats.
--   user_id        copied from the notification so "my deliveries" lists need no join.
CREATE TABLE deliveries (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  notification_id BIGINT UNSIGNED NOT NULL,
  channel_id      BIGINT UNSIGNED NOT NULL,
  status          ENUM('pending','sending','retrying','delivered','failed','dead') NOT NULL DEFAULT 'pending',
  priority        TINYINT         NOT NULL DEFAULT 0,
  attempt_count   INT             NOT NULL DEFAULT 0,
  total_attempts  INT             NOT NULL DEFAULT 0,
  max_attempts    INT             NOT NULL DEFAULT 6,
  next_attempt_at DATETIME(3)     NOT NULL,
  locked_by       VARCHAR(64)     NULL,
  locked_at       DATETIME(3)     NULL,
  last_error      VARCHAR(500)    NULL,
  delivered_at    DATETIME(3)     NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_deliveries_ntf_channel (notification_id, channel_id),
  KEY idx_due (status, priority DESC, next_attempt_at),
  KEY idx_stuck (status, locked_at),
  KEY idx_deliveries_user_created (user_id, created_at, id),
  KEY idx_deliveries_channel (channel_id),
  CONSTRAINT fk_deliveries_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_deliveries_notification FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE CASCADE,
  CONSTRAINT fk_deliveries_channel FOREIGN KEY (channel_id) REFERENCES channels (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only audit log: one row per send attempt.
CREATE TABLE delivery_attempts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id BIGINT UNSIGNED NOT NULL,
  attempt_no  INT             NOT NULL,
  started_at  DATETIME(3)     NOT NULL,
  finished_at DATETIME(3)     NOT NULL,
  duration_ms INT             NOT NULL,
  outcome     ENUM('success','retryable_error','permanent_error') NOT NULL,
  http_status SMALLINT        NULL,
  error       VARCHAR(500)    NULL,
  PRIMARY KEY (id),
  KEY idx_attempts_delivery (delivery_id, attempt_no),
  CONSTRAINT fk_attempts_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE alert_rules (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  name              VARCHAR(100)    NOT NULL,
  symbol            VARCHAR(20)     NOT NULL,
  provider          ENUM('simulated','coingecko','binance') NOT NULL,
  condition_type    ENUM('above','below','cross_above','cross_below','pct_move') NOT NULL,
  threshold         DECIMAL(20,8)   NOT NULL,
  window_minutes    INT             NULL,
  cooldown_minutes  INT             NOT NULL DEFAULT 60,
  state             ENUM('armed','triggered','cooldown') NOT NULL DEFAULT 'armed',
  last_price        DECIMAL(20,8)   NULL,
  last_triggered_at DATETIME(3)     NULL,
  is_active         BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_alert_rules_active (is_active, provider, symbol),
  KEY idx_alert_rules_user (user_id, created_at, id),
  CONSTRAINT fk_alert_rules_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE alert_rule_channels (
  rule_id    BIGINT UNSIGNED NOT NULL,
  channel_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (rule_id, channel_id),
  KEY idx_arc_channel (channel_id),
  CONSTRAINT fk_arc_rule FOREIGN KEY (rule_id) REFERENCES alert_rules (id) ON DELETE CASCADE,
  CONSTRAINT fk_arc_channel FOREIGN KEY (channel_id) REFERENCES channels (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE price_snapshots (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider    ENUM('simulated','coingecko','binance') NOT NULL,
  symbol      VARCHAR(20)     NOT NULL,
  price       DECIMAL(20,8)   NOT NULL,
  observed_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_snapshots_lookup (provider, symbol, observed_at),
  KEY idx_snapshots_observed (observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE alert_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rule_id         BIGINT UNSIGNED NOT NULL,
  price           DECIMAL(20,8)   NOT NULL,
  condition_type  ENUM('above','below','cross_above','cross_below','pct_move') NOT NULL,
  threshold       DECIMAL(20,8)   NOT NULL,
  triggered_at    DATETIME(3)     NOT NULL,
  notification_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY idx_alert_events_rule (rule_id, triggered_at),
  KEY idx_alert_events_notification (notification_id),
  CONSTRAINT fk_alert_events_rule FOREIGN KEY (rule_id) REFERENCES alert_rules (id) ON DELETE CASCADE,
  CONSTRAINT fk_alert_events_notification FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per user per day; counters bumped with INSERT ... ON DUPLICATE KEY UPDATE.
CREATE TABLE usage_daily (
  user_id       BIGINT UNSIGNED NOT NULL,
  day           DATE            NOT NULL,
  api_requests  INT             NOT NULL DEFAULT 0,
  notifications INT             NOT NULL DEFAULT 0,
  deliveries    INT             NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day),
  CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
