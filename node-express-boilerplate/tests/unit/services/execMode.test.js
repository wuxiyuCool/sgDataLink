/**
 * 执行模式与引擎快照（docs/API.md 4.1 / 5）单测。
 *
 * 覆盖三件事：
 * 1. memory 驱动下 resolveExecMode 恒为 simulate（真实读写只在 DB_DRIVER=mysql 下成立）；
 * 2. simulate 快照保持旧结构且**不含任何凭据**，real 快照才带完整连接体 + fieldMappings + offsetStart
 *    （real 分支用显式传 mode 的方式触发，避免单测里再去连 MySQL）；
 * 3. offsetValue → offsetStart 的位点解析（复合分片串取增量列那一段）。
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DB_DRIVER = 'memory';
process.env.MEM_MOCK = 'true';

const runService = require('../../../src/services/run.service');
const syncTaskService = require('../../../src/services/syncTask.service');
const offsetRepository = require('../../../src/repositories/offset.repository');
const datasourceService = require('../../../src/services/datasource.service');

const PASSWORD = 'Sup3r#Secret';

const createMysqlDatasource = (name, database) =>
  datasourceService.createDataSource({
    name,
    type: 'mysql',
    host: '10.45.34.222',
    port: 3306,
    database,
    username: 'root',
    password: PASSWORD,
  });

const createTask = async (source, target) =>
  syncTaskService.createTask({
    name: '单测全量任务',
    syncMode: 'full',
    sourceId: source.id,
    sourceTable: 'T_SRC',
    targetId: target.id,
    targetTable: 'T_DST',
    writeMode: 'upsert',
    batchSize: 500,
    fieldMappings: [{ sourceField: 'ID', targetField: 'ID', primaryKey: true }],
  });

describe('执行模式判定与引擎快照', () => {
  it('memory 驱动下即使两端都是 mysql 也只判 simulate', async () => {
    const source = await createMysqlDatasource('单测源-内存', 'src1');
    const target = await createMysqlDatasource('单测目标-内存', 'dst1');
    await expect(runService.resolveExecMode(source.id, target.id)).resolves.toBe('simulate');
  });

  it('数据源不存在时按 simulate 处理（不会因为查不到就当真读写在跑）', async () => {
    const target = await createMysqlDatasource('单测目标-缺失源', 'dst2');
    await expect(runService.resolveExecMode('ds-not-exists', target.id)).resolves.toBe('simulate');
  });

  it('endpointOf 缺省（simulate）只回摘要，带 mode=real 才回完整连接体 + table', async () => {
    const source = await createMysqlDatasource('单测源-端点', 'src3');
    const summary = await runService.endpointOf(source.id);
    expect(summary).toEqual({ id: source.id, type: 'mysql', database: 'src3' });
    expect(summary.password).toBeUndefined();

    const full = await runService.endpointOf(source.id, { mode: 'real', table: 'T_SRC' });
    expect(full).toEqual({
      id: source.id,
      type: 'mysql',
      host: '10.45.34.222',
      port: 3306,
      database: 'src3',
      username: 'root',
      password: PASSWORD,
      table: 'T_SRC',
    });
  });

  it('任务快照：simulate 保持旧结构（无凭据 / 无 fieldMappings），real 才补齐契约 5 的字段', async () => {
    const source = await createMysqlDatasource('单测源-快照', 'src4');
    const target = await createMysqlDatasource('单测目标-快照', 'dst4');
    const task = await createTask(source, target);

    const simulated = await syncTaskService.buildEngineSnapshot(task, 'inst-sim', 1000);
    expect(simulated.mode).toBe('simulate');
    expect(simulated.source).not.toHaveProperty('password');
    expect(simulated.source).not.toHaveProperty('host');
    expect(simulated.fieldMappings).toBeUndefined();
    expect(simulated.offsetStart).toBeUndefined();

    const real = await syncTaskService.buildEngineSnapshot(task, 'inst-real', 1000, { mode: 'real' });
    expect(real.mode).toBe('real');
    expect(real.source).toMatchObject({ host: '10.45.34.222', port: 3306, username: 'root', table: 'T_SRC' });
    expect(real.target.table).toBe('T_DST');
    expect(real.fieldMappings).toEqual(task.fieldMappings);
    // 该任务还没有任何点位 -> 起始位点为 null（引擎按全量从头拉）
    expect(real.offsetStart).toBeNull();

    await offsetRepository.create({
      taskId: task.id,
      instanceId: 'inst-prev',
      shardKey: 'default',
      offsetValue: 'UPDATE_TIME=2026-09-21T20:33:03Z',
    });
    const resumed = await syncTaskService.buildEngineSnapshot(task, 'inst-real-2', 1000, { mode: 'real' });
    expect(resumed.offsetStart).toBe('2026-09-21T20:33:03Z');
  });

  it('parseOffsetStart 处理复合位点与纯位点串', () => {
    expect(runService.parseOffsetStart('UPDATE_TIME=2026-09-18T12:00:00Z', 'UPDATE_TIME')).toBe('2026-09-18T12:00:00Z');
    // 复合分片点位：优先取增量列那一段，而不是 ROWID
    expect(runService.parseOffsetStart('UPDATE_TIME=2026-09-18T12:00:00Z/ROWID=aaa', 'UPDATE_TIME')).toBe(
      '2026-09-18T12:00:00Z'
    );
    expect(runService.parseOffsetStart('ROWID=AAAKYmAAEAAAf7XAA1')).toBe('AAAKYmAAEAAAf7XAA1');
    expect(runService.parseOffsetStart('2026-09-18T12:00:00Z')).toBe('2026-09-18T12:00:00Z');
    expect(runService.parseOffsetStart(null)).toBeNull();
    expect(runService.parseOffsetStart('')).toBeNull();
  });
});
