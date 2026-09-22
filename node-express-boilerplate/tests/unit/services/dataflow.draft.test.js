/**
 * 数据开发「草稿态」语义（docs/API.md 4.1 / 1.8）单测。
 *
 * 契约要求：保存画布允许 input/output 暂缺 config.datasourceId / table（新建弹窗的预置节点
 * 就是这个形态），只有 run 时才强制端点配置完整并回 40001。
 * 这里直接打 service（Joi 层在 HTTP 侧另有一轮），所以不依赖任何数据库或 Go 引擎：
 * run 的 40001 发生在拼引擎快照之前，engineClient 不会被调用。
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DB_DRIVER = 'memory';
process.env.MEM_MOCK = 'true';

const dataflowService = require('../../../src/services/dataflow.service');
const datasourceService = require('../../../src/services/datasource.service');
const { ERROR_CODES } = require('../../../src/config/errorCodes');

/** 草稿画布：两个端点节点存在，但 config 里既没有 datasourceId 也没有 table */
const draftNodes = () => [
  { id: 'in1', type: 'input', name: '读库（待配置）', config: {} },
  { id: 'out1', type: 'output', name: '写库（待配置）', config: {} },
];

const draftEdges = () => [{ source: 'in1', target: 'out1' }];

describe('dataflow 草稿态（契约 4.1）', () => {
  it('create 允许端点缺 config，原样存下画布', async () => {
    const created = await dataflowService.createDataflow({
      name: '草稿画布',
      nodes: draftNodes(),
      edges: draftEdges(),
    });
    expect(created.id).toMatch(/^df-/);
    expect(created.nodes[0].config).toEqual({});
    expect(created.lastStatus).toBe('idle');
  });

  it('update 允许只改名字不碰画布', async () => {
    const created = await dataflowService.createDataflow({
      name: '草稿画布2',
      nodes: draftNodes(),
      edges: draftEdges(),
    });
    const updated = await dataflowService.updateDataflowById(created.id, { name: '草稿画布2-改名' });
    expect(updated.name).toBe('草稿画布2-改名');
    expect(updated.nodes).toHaveLength(2);
  });

  it('run 草稿 → 40001（端点缺 config 时不允许下发）', async () => {
    const created = await dataflowService.createDataflow({
      name: '草稿画布3',
      nodes: draftNodes(),
      edges: draftEdges(),
    });
    await expect(dataflowService.runDataflow(created.id)).rejects.toMatchObject({
      bizCode: ERROR_CODES.PARAM_INVALID,
      statusCode: 400,
      message: expect.stringContaining('缺少 config.datasourceId'),
    });
    // 下发失败要回滚：实例被删掉，任务状态不会卡在 running
    await expect(dataflowService.getDataflowById(created.id)).resolves.toMatchObject({ lastStatus: 'idle' });
  });

  it('run 时端点数据源缺失同样 40001（config 齐了但 datasourceId 查不到）', async () => {
    const created = await dataflowService.createDataflow({
      name: '草稿画布4',
      nodes: [
        { id: 'in1', type: 'input', name: '读库', config: { datasourceId: 'ds-not-exists', table: 'T_A' } },
        { id: 'out1', type: 'output', name: '写库', config: { datasourceId: 'ds-9999', table: 'T_B' } },
      ],
      edges: draftEdges(),
    });
    await expect(dataflowService.runDataflow(created.id)).rejects.toMatchObject({
      bizCode: ERROR_CODES.PARAM_INVALID,
    });
  });

  it('配置完整的画布能算出执行模式（memory 驱动恒为 simulate）', async () => {
    const source = await datasourceService.createDataSource({
      name: '草稿源MySQL',
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      database: 'src',
      username: 'u',
      password: 'p',
    });
    const target = await datasourceService.createDataSource({
      name: '草稿目标MySQL',
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      database: 'dst',
      username: 'u',
      password: 'p',
    });
    const created = await dataflowService.createDataflow({
      name: '可运行画布',
      nodes: [
        { id: 'in1', type: 'input', name: '读库', config: { datasourceId: source.id, table: 'T_A' } },
        { id: 'out1', type: 'output', name: '写库', config: { datasourceId: target.id, table: 'T_B' } },
      ],
      edges: draftEdges(),
    });
    const snapshot = await dataflowService.buildEngineSnapshot(created, 'inst-draft', 100);
    // memory 驱动（演示模式）永远是 simulate，且快照里不得出现任何凭据
    expect(snapshot.mode).toBe('simulate');
    expect(JSON.stringify(snapshot)).not.toContain('password');
    expect(snapshot.source).toEqual({ id: source.id, type: 'mysql', database: 'src' });
  });
});
