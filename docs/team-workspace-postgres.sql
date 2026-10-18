-- PostgreSQL 16+ 蓝图：个人数据隔离 + 团队全局文件查重
-- 不能在现有 SQLite 生产库执行；请使用迁移脚本和隔离 staging 环境。
BEGIN;
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK(role IN ('admin','operator','viewer')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','disabled')),
  PRIMARY KEY(team_id,user_id)
);
CREATE TABLE account_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  fingerprint text NOT NULL,
  country text NOT NULL DEFAULT '',
  product text NOT NULL DEFAULT '',
  domain text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'normal',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(team_id,owner_id) REFERENCES team_members(team_id,user_id),
  UNIQUE(id,team_id),
  UNIQUE(team_id,owner_id,fingerprint)
);
CREATE INDEX ix_accounts_private ON account_records(team_id,owner_id,created_at DESC);

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('email','proxy','payment_token','license')),
  label text NOT NULL,
  status text NOT NULL DEFAULT 'unused' CHECK(status IN ('unused','used','disabled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_reference text, -- 服务端凭据保管箱引用；不保存明文密码/PAN/CVV/2FA
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(team_id,owner_id) REFERENCES team_members(team_id,user_id),
  UNIQUE(id,team_id),
  UNIQUE(id,team_id,owner_id)
);
CREATE INDEX ix_resources_private ON resources(team_id,owner_id,kind,status);

-- 无“查看全局文件列表”权限：接口仅基于 hash 返回重复是否成立。
CREATE TABLE file_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_by uuid NOT NULL,
  object_key text NOT NULL UNIQUE, -- 私有对象存储 key；不可直链公共访问
  original_filename text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes>0),
  mime_type text NOT NULL DEFAULT 'application/pdf',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY(team_id,uploaded_by) REFERENCES team_members(team_id,user_id),
  UNIQUE(id,team_id),
  UNIQUE(team_id,sha256) -- 包含撤销记录：删除后也不允许不经审批地重复导入
);

CREATE TABLE business_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  file_id uuid,
  organization_name text NOT NULL,
  normalized_org_name text,
  registration_number text,
  normalized_registration_number text,
  address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(team_id,owner_id) REFERENCES team_members(team_id,user_id),
  FOREIGN KEY(resource_id,team_id,owner_id) REFERENCES resources(id,team_id,owner_id),
  FOREIGN KEY(file_id,team_id) REFERENCES file_registry(id,team_id),
  UNIQUE(team_id,normalized_org_name),
  UNIQUE(team_id,normalized_registration_number),
  UNIQUE(file_id)
);
CREATE INDEX ix_licenses_private ON business_licenses(team_id,owner_id,created_at DESC);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES teams(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  event_type text NOT NULL,
  entity_kind text NOT NULL,
  entity_id uuid,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, -- 禁止原文凭据与他人资料
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_team_date ON audit_events(team_id,occurred_at DESC);

COMMIT;

-- 业务查询必须由服务端 session 决定 team_id / owner_id：
-- SELECT * FROM account_records WHERE team_id=$1 AND owner_id=$2;
-- SELECT * FROM resources WHERE team_id=$1 AND owner_id=$2;
-- 将来可增加 PostgreSQL Row Level Security；不要信任客户端传入的 owner_id。
-- 先验证 SHA，再在单个事务中 INSERT file_registry，凭 UNIQUE(team_id,sha256)
-- 处理并发两个成员同时上传同一文件的情况。捕获 unique_violation 返回 HTTP 409。
