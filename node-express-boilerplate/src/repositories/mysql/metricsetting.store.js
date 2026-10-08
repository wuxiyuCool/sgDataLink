/**
 * 指标中心系统配置仓储（MySQL 实现，契约 1.12）。
 * setting_key 主键的 kv 表，不走 defineStore（无 id 前缀语义），直接 bespoke SQL。
 */
const db = require('../../db/mysql');
const { nowIso } = require('../memoryStore');

const TABLE = 'databridge_metric_setting';

const fromRow = (row) => ({
  settingKey: row.setting_key,
  settingValue: row.setting_value === null ? '' : String(row.setting_value),
  secret: Boolean(row.secret),
  updatedBy: row.updated_by || '',
  updatedAt: row.updated_at ? `${String(row.updated_at).replace(' ', 'T')}Z` : null,
});

const list = async () => {
  const rows = await db.query(`SELECT * FROM \`${TABLE}\` ORDER BY seq ASC`);
  return rows.map(fromRow);
};

const getByKey = async (settingKey) => {
  const rows = await db.query(`SELECT * FROM \`${TABLE}\` WHERE setting_key = ?`, [String(settingKey)]);
  return rows.length ? fromRow(rows[0]) : null;
};

const upsert = async ({ settingKey, settingValue, secret = false, updatedBy = '' }) => {
  const key = String(settingKey);
  const timestamp = nowIso();
  await db.run(
    `INSERT INTO \`${TABLE}\` (setting_key, setting_value, secret, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), secret = VALUES(secret),
       updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
    [key, String(settingValue), secret ? 1 : 0, String(updatedBy), timestamp.replace('T', ' ').replace('Z', '')]
  );
  const record = await getByKey(key);
  return (
    record || {
      settingKey: key,
      settingValue: String(settingValue),
      secret: Boolean(secret),
      updatedBy,
      updatedAt: timestamp,
    }
  );
};

const remove = async (settingKey) => {
  const result = await db.run(`DELETE FROM \`${TABLE}\` WHERE setting_key = ?`, [String(settingKey)]);
  return result.affectedRows > 0;
};

const clear = async () => {
  await db.run(`DELETE FROM \`${TABLE}\``);
  return true;
};

module.exports = { list, getByKey, upsert, remove, clear };
