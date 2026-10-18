-- PostgreSQL 16+; 仅用于规划/全新 staging 数据库，不是 SQLite 在线迁移脚本
-- 生产部署需额外安装 UUID 生成扩展（PG 13+ 支持 gen_random_uuid）。
BEGIN;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text,
  display_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner','admin','operator','viewer')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_members_user ON workspace_members(user_id) WHERE revoked_at IS NULL;

CREATE TABLE ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  fingerprint text NOT NULL,
  country text NOT NULL DEFAULT '',
  product text NOT NULL DEFAULT '',
  domain text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal','attention','suspended','archived')),
  assignee_id uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE(id,workspace_id),
  UNIQUE(workspace_id,fingerprint)
);
CREATE INDEX idx_accounts_workspace_status ON ad_accounts(workspace_id,status,created_at DESC);
CREATE INDEX idx_accounts_workspace_assignee ON ad_accounts(workspace_id,assignee_id);

CREATE TABLE file_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  sha256 char(64) NOT NULL,
  object_key text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,workspace_id),
  UNIQUE(workspace_id,sha256),
  UNIQUE(object_key)
);

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('email','proxy','payment_token','license')),
  label text NOT NULL,
  unique_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK(status IN('available','assigned','disabled','archived')),
  share_policy text NOT NULL DEFAULT 'exclusive' CHECK(share_policy IN ('exclusive','shared')),
  public_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ref text, -- 指向凭据保管服务；这里不存明文密码/CVV/PAN
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  archived_at timestamptz,
  UNIQUE(id,workspace_id),
  UNIQUE(workspace_id,kind,unique_fingerprint)
);
CREATE INDEX idx_resources_available ON resources(workspace_id,kind,status) WHERE archived_at IS NULL;
CREATE INDEX idx_resources_meta ON resources USING gin(public_metadata);

CREATE TABLE license_profiles (
  resource_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  organization_name text NOT NULL,
  legal_name text NOT NULL,
  country_code char(2),
  registry_number text,
  address text,
  city text,
  zip text,
  file_object_id uuid,
  FOREIGN KEY(resource_id,workspace_id) REFERENCES resources(id,workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY(file_object_id,workspace_id) REFERENCES file_objects(id,workspace_id)
);
CREATE UNIQUE INDEX idx_license_registry ON license_profiles(workspace_id,country_code,registry_number) WHERE registry_number IS NOT NULL AND registry_number <> '';

CREATE TABLE resource_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  is_exclusive boolean NOT NULL,
  assigned_by uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  FOREIGN KEY(account_id,workspace_id) REFERENCES ad_accounts(id,workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY(resource_id,workspace_id) REFERENCES resources(id,workspace_id) ON DELETE RESTRICT,
  CHECK (released_at IS NULL OR released_at >= assigned_at)
);
CREATE UNIQUE INDEX uq_active_exclusive_resource ON resource_assignments(resource_id) WHERE released_at IS NULL AND is_exclusive;
CREATE UNIQUE INDEX uq_active_account_kind_resource ON resource_assignments(account_id,resource_id) WHERE released_at IS NULL;
CREATE INDEX idx_assignments_workspace_account ON resource_assignments(workspace_id,account_id) WHERE released_at IS NULL;
-- 应用事务中必须强制验证 is_exclusive 与 resources.share_policy 一致；或增加数据库 trigger。

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES users(id),
  subject_type text NOT NULL,
  subject_id text,
  action text NOT NULL,
  request_id uuid,
  safe_diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_workspace_time ON audit_events(workspace_id,occurred_at DESC);
-- safe_diff 明令禁止包含账号密码/2FA/代理密码/卡号/CVV/PDF原文

CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  key text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  request_hash char(64) NOT NULL,
  response_body jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','done','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,key)
);
CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

COMMIT;
