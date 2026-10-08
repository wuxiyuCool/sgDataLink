/**
 * Swagger 文档中心（docs/API.md 1.9.4）：把 Data API 定义聚合成 OpenAPI 3.0.3 文档。
 *
 * 约定：
 * - 每个 Data API 一条 path（/ds/{path}），tags=[数据源名] 供前端按数据源筛选；
 * - 文档文案取 apiDoc（缺失时现场按模板生成，不反向写库）；
 * - 参数来自 queryParams + 分页 page/size；响应按运行时 result 形状
 *   （builder/custom 为统一信封 + {fields,rows,total,page,size}，forward 为下游透传）；
 * - operationId 用 path 连字符名，x-databridge 扩展携带 apiId/datasourceId/sqlMode 供跳转编辑。
 * 访问控制（JWT、status=all 仅 admin）在路由/控制器层，这里只管生成。
 */
const dataApiRepository = require('../repositories/dataapi.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const { buildApiDocTemplate, isEmptyDoc, sqlModeOf } = require('./dataapi.service');

const OPENAPI_VERSION = '3.0.3';

/** queryParams 类型 -> OpenAPI 参数 schema（list 用逗号分隔的数组语义） */
const PARAM_SCHEMAS = {
  string: { type: 'string' },
  number: { type: 'number' },
  date: { type: 'string', example: '2026-01-15 09:30:00', description: '时间字符串，建议 YYYY-MM-DD HH24:MI:SS 口径' },
  list: { type: 'array', items: { type: 'string' }, description: '多值：逗号分隔（codes=A,B,C）或重复参数，上限 1000 个' },
  boolean: { type: 'boolean' },
};

const pickDoc = (api) => (isEmptyDoc(api.apiDoc) ? buildApiDocTemplate(api) : api.apiDoc);

/** 数据源名 -> tag；forward 或未绑定数据源落到语义化兜底 tag */
const tagOf = (api, datasourceNames) => {
  if (sqlModeOf(api) === 'forward') return 'API 转发';
  const name = api.datasourceId && datasourceNames.get(String(api.datasourceId));
  return name || '未绑定数据源';
};

/** 字段类型 -> OpenAPI 标量类型（rows 是二维数组，按列类型给 items 提示） */
const openApiTypeOf = (fieldType) => {
  const type = String(fieldType || '').toUpperCase();
  if (/INT|NUMBER|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|BIT/.test(type)) return 'number';
  if (/BOOL/.test(type)) return 'boolean';
  return 'string';
};

/** builder/custom 的 200 响应：统一信封 + 分页数据 result（example 来自 apiDoc.responseExample） */
const buildQueryResponse = (api, doc) => {
  const fields = (Array.isArray(api.fields) ? api.fields : []).filter((f) => f && f.name);
  const example = doc.responseExample && doc.responseExample.fields
    ? {
        code: 0,
        message: 'success',
        result: {
          fields: doc.responseExample.fields,
          rows: doc.responseExample.rows || [],
          total: doc.responseExample.total ?? (doc.responseExample.rows || []).length,
          page: doc.responseExample.page ?? 1,
          size: doc.responseExample.size ?? 20,
        },
      }
    : undefined;
  return {
    description: '成功（统一信封，HTTP 200）',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            code: { type: 'integer', example: 0 },
            message: { type: 'string', example: 'success' },
            result: {
              type: 'object',
              properties: {
                fields: { type: 'array', items: { type: 'string' }, example: fields.map((f) => f.name) },
                rows: {
                  type: 'array',
                  items: {
                    type: 'array',
                    description: '一行数据，列顺序与 fields 一致',
                    items: fields.length
                      ? { oneOf: [{ type: 'number' }, { type: 'string' }] }
                      : {},
                  },
                },
                total: { type: 'integer', description: '满足条件的总行数' },
                page: { type: 'integer' },
                size: { type: 'integer' },
              },
            },
            timestamp: { type: 'integer', format: 'int64' },
          },
        },
        ...(example ? { example } : {}),
      },
    },
  };
};

/** forward 的 200 响应：下游响应体原样透传（不包信封） */
const buildForwardResponse = (api, doc) => ({
  description: '下游响应透传（原样返回下游系统的状态码与响应体，不包统一信封）',
  content: {
    'application/json': {
      schema: { type: 'object', description: '由下游系统决定，DataBridge 不解析' },
      ...(doc.responseExample ? { example: doc.responseExample } : {}),
    },
  },
});

const ERROR_DESCRIPTIONS = [
  '401/40101 未提供 X-API-Key；401/40102 Key 无效',
  '403/40301 来源 IP 不在白名单',
  '429/42901 超过限流 QPS',
  '404/40404 服务不存在或未发布',
  '502/50003 查询失败或转发目标异常',
].join('；');

const buildOperation = (api, datasourceNames) => {
  const doc = pickDoc(api);
  const mode = sqlModeOf(api);
  const params = (Array.isArray(api.queryParams) ? api.queryParams : [])
    .filter((p) => p && p.name)
    .map((p) => ({
      name: p.name,
      in: 'query',
      required: Boolean(p.required),
      description: (doc.paramDocs || {})[p.name] || p.remark || `${p.type || 'string'}${p.required ? '，必填' : '，可选'}`,
      schema: PARAM_SCHEMAS[p.type] || PARAM_SCHEMAS.string,
    }));
  if (mode !== 'forward') {
    params.push(
      { name: 'page', in: 'query', required: false, description: '页码，默认 1', schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'size', in: 'query', required: false, description: '每页行数，默认 20，上限 500（别名 limit）', schema: { type: 'integer', minimum: 1, maximum: 500, default: 20 } }
    );
  }
  const operation = {
    tags: [tagOf(api, datasourceNames)],
    summary: doc.summary || `${api.name}（${api.method || 'GET'} /ds/${api.path}）`,
    description: [
      doc.description || '',
      api.tableName ? `来源表：${api.tableName}` : '',
      `状态：${api.status === 'published' ? '已发布' : '草稿（下线状态下调用返回 40404）'}`,
    ]
      .filter(Boolean)
      .join('；'),
    operationId: `ds-${api.path}`.replace(/\//g, '-'),
    parameters: params,
    responses: {
      200: mode === 'forward' ? buildForwardResponse(api, doc) : buildQueryResponse(api, doc),
      default: { description: `业务失败（统一信封，HTTP 状态码同步变化）：${ERROR_DESCRIPTIONS}` },
    },
    'x-databridge': {
      apiId: api.id,
      apiName: api.name,
      datasourceId: api.datasourceId || null,
      sqlMode: mode,
      status: api.status,
      authEnabled: Boolean(api.authEnabled),
      rateLimitQps: api.rateLimitQps || null,
    },
  };
  if (api.authEnabled) operation.security = [{ ApiKeyAuth: [] }];
  return operation;
};

/**
 * 文档中心自身的接口（自描述，tag=[文档中心]，不受 keyword 过滤影响）：
 * 开发者在文档里就能查到「怎么取本文档 / 怎么登录拿 JWT / 怎么查看与刷新自己的 docKey / 访问日志怎么查」。
 * 这些是管理端接口，响应按统一信封 {code,message,result,timestamp}（swagger.json 本体除外）。
 */
const envelopeExample = (result) => ({ code: 0, message: 'success', result, timestamp: 1700000000000 });
const envelopeSchema = (resultSchema) => ({
  type: 'object',
  properties: {
    code: { type: 'integer', example: 0 },
    message: { type: 'string', example: 'success' },
    result: resultSchema,
    timestamp: { type: 'integer', format: 'int64' },
  },
});

const jsonResp = (description, schema, example) => ({
  description,
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});

const DOC_CENTER_TAG = ['文档中心'];

const buildDocCenterPaths = () => ({
  '/api/v1/data-apis/swagger.json': {
    get: {
      tags: DOC_CENTER_TAG,
      summary: '获取本文档（OpenAPI 3.0 本体，响应不套统一信封）',
      description:
        '两种认证任选其一：1) 登录 JWT（Authorization: Bearer，见 /api/v1/auth/login）；2) 个人文档 Key（X-DOC-KEY 请求头或 docKey 查询参数，免登录，需管理员在用户管理中开通，见契约 1.9.5）。docKey 通道只返回已发布文档；每次访问都会记入文档访问日志。',
      operationId: 'databridge-swagger-spec',
      parameters: [
        { name: 'docKey', in: 'query', required: false, description: '个人文档 Key（与 X-DOC-KEY 头二选一）', schema: { type: 'string', example: 'dok-9f3a…32hex' } },
        { name: 'status', in: 'query', required: false, description: '缺省 published；all=含草稿（仅管理员 JWT，docKey 传 all 会被 40001 拒绝）', schema: { type: 'string', enum: ['published', 'all'], default: 'published' } },
        { name: 'keyword', in: 'query', required: false, description: '按 path/服务名模糊过滤 Data API 条目（不影响本分组）', schema: { type: 'string' } },
      ],
      security: [{ BearerAuth: [] }, { DocKeyAuth: [] }],
      responses: {
        200: { description: 'OpenAPI spec 本体', content: { 'application/json': { schema: { type: 'object', description: 'openapi/info/tags/paths/…（即你正在看的这份文档的结构）' } } } },
        default: { description: '401/40101|40102 未登录且 docKey 缺失或无效；401/40105 账号被禁用导致 docKey 失效' },
      },
    },
  },
  '/api/v1/auth/login': {
    post: {
      tags: DOC_CENTER_TAG,
      summary: '登录获取 JWT（页面登录用；脚本长期取文档建议改用 docKey）',
      operationId: 'databridge-auth-login',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { username: { type: 'string' }, password: { type: 'string' } }, required: ['username', 'password'] }, example: { username: 'admin', password: '…' } } },
      },
      responses: {
        200: jsonResp('登录成功（token 放进后续请求的 Authorization: Bearer <token>）', envelopeSchema({ type: 'object', properties: { token: { type: 'string' }, expiresInSec: { type: 'integer' }, user: { type: 'object' } } }), envelopeExample({ token: 'eyJhbGci…', expiresInSec: 1800, user: { id: 'usr-9701', username: 'admin', role: 'admin' } })),
        default: { description: '401/40103 用户名或密码错误（防枚举不区分原因）；403/40104 账号被禁用；失败也会写登录日志' },
      },
    },
  },
  '/api/v1/auth/doc-key': {
    get: {
      tags: DOC_CENTER_TAG,
      summary: '查看本人文档权限与 docKey（明文只回本人）',
      operationId: 'databridge-get-doc-key',
      security: [{ BearerAuth: [] }],
      responses: {
        200: jsonResp('当前用户的文档权限', envelopeSchema({ type: 'object', properties: { docAccess: { type: 'boolean' }, docKey: { type: 'string', nullable: true }, updatedAt: { type: 'string', nullable: true } } }), envelopeExample({ docAccess: true, docKey: 'dok-9f3a…', updatedAt: '2026-10-08T06:30:00.000Z' })),
      },
    },
  },
  '/api/v1/auth/doc-key/refresh': {
    post: {
      tags: DOC_CENTER_TAG,
      summary: '刷新本人 docKey（旧 key 立即失效；未开通权限返回 40001）',
      operationId: 'databridge-refresh-doc-key',
      security: [{ BearerAuth: [] }],
      responses: {
        200: jsonResp('新 key（仅本次与 GET /auth/doc-key 可见）', envelopeSchema({ type: 'object', properties: { docAccess: { type: 'boolean' }, docKey: { type: 'string' }, updatedAt: { type: 'string' } } }), envelopeExample({ docAccess: true, docKey: 'dok-1b7c…', updatedAt: '2026-10-08T07:00:00.000Z' })),
      },
    },
  },
  '/api/v1/data-apis/{id}/doc': {
    get: {
      tags: DOC_CENTER_TAG,
      summary: '取单个 Data API 的文档配置（apiDoc；未填过返回按定义生成的模板）',
      operationId: 'databridge-get-api-doc',
      parameters: [{ name: 'id', in: 'path', required: true, description: 'Data API id（如 api-8001，可见于各条目 x-databridge.apiId）', schema: { type: 'string' } }],
      security: [{ BearerAuth: [] }],
      responses: { 200: jsonResp('apiDoc', envelopeSchema({ type: 'object', properties: { summary: { type: 'string' }, description: { type: 'string' }, paramDocs: { type: 'object' }, responseExample: { type: 'object' } } }), envelopeExample({ summary: '订单查询（GET /ds/order-query）', description: '构建模式：查询 T_ORDER', paramDocs: { status: 'string，必填' }, responseExample: { fields: ['ID'], rows: [[1], [2]] } })) },
    },
    put: {
      tags: DOC_CENTER_TAG,
      summary: '保存文档配置（仅管理员 JWT；docKey 不可用）',
      operationId: 'databridge-put-api-doc',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { summary: { type: 'string' }, description: { type: 'string' }, paramDocs: { type: 'object' }, responseExample: { type: 'object' } } } } } },
      security: [{ BearerAuth: [] }],
      responses: { 200: jsonResp('保存后的 apiDoc', envelopeSchema({ type: 'object' })) },
    },
  },
  '/api/v1/data-apis/swagger-logs': {
    get: {
      tags: DOC_CENTER_TAG,
      summary: '文档访问日志分页（仅管理员 JWT）：每次取文档（JWT 或 docKey、成败）都留痕',
      operationId: 'databridge-swagger-logs',
      parameters: [
        { name: 'keyword', in: 'query', required: false, description: '用户名或 IP 模糊', schema: { type: 'string' } },
        { name: 'result', in: 'query', required: false, schema: { type: 'string', enum: ['success', 'error'] } },
        { name: 'authType', in: 'query', required: false, description: 'jwt=登录态访问，docKey=免登录访问', schema: { type: 'string', enum: ['jwt', 'docKey'] } },
        { name: 'startTime', in: 'query', required: false, description: 'ISO 时间闭区间起', schema: { type: 'string' } },
        { name: 'endTime', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1 } },
        { name: 'size', in: 'query', required: false, schema: { type: 'integer', default: 20, maximum: 500 } },
      ],
      security: [{ BearerAuth: [] }],
      responses: {
        200: jsonResp('分页信封（key 只存掩码，滚动保留 1 万条）', envelopeSchema({ type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' }, page: { type: 'integer' }, size: { type: 'integer' }, pages: { type: 'integer' } } }), envelopeExample({ items: [{ id: 'dal-…', username: 'zhangsan', authType: 'docKey', keyMasked: 'dok-9f***', ip: '10.45.34.12', ok: true, httpStatus: 200, keyword: 'order', createdAt: '2026-10-08T07:10:00.000Z' }], total: 1, page: 1, size: 20, pages: 1 })),
      },
    },
  },
});

/**
 * 生成 OpenAPI 3.0 文档。
 * @param {Object} options { status: 'published'|'all', keyword }（all 的 admin 权限由控制器把关）
 * @returns {Promise<Object>} OpenAPI spec（直接作为 swagger.json 响应体，不套信封）
 */
const buildSpec = async ({ status = 'published', keyword = '' } = {}) => {
  const all = await dataApiRepository.find({ sort: 'createdAt:asc' });
  const needle = String(keyword || '').trim().toLowerCase();
  const apis = all.filter((api) => {
    if (status !== 'all' && api.status !== 'published') return false;
    if (!needle) return true;
    return (
      String(api.path || '').toLowerCase().includes(needle) || String(api.name || '').toLowerCase().includes(needle)
    );
  });

  const datasourceNames = new Map();
  // eslint-disable-next-line no-restricted-syntax
  for (const id of Array.from(new Set(apis.map((api) => api.datasourceId).filter(Boolean)))) {
    // eslint-disable-next-line no-await-in-loop
    const ds = await datasourceRepository.getById(id);
    if (ds) datasourceNames.set(String(id), ds.name);
  }

  const paths = {};
  apis.forEach((api) => {
    if (!api.path) return;
    const key = `/ds/${api.path}`;
    const method = String(api.method || 'GET').toLowerCase();
    paths[key] = { ...(paths[key] || {}), [method]: buildOperation(api, datasourceNames) };
  });
  // 文档中心自身接口固定追加（自描述，keyword 只过滤业务 /ds 条目）
  Object.assign(paths, buildDocCenterPaths());

  const tags = Array.from(new Set(Object.values(paths).flatMap((item) => Object.values(item).map((op) => op.tags[0]))));
  const publishedCount = apis.filter((api) => api.status === 'published').length;
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'DataBridge 数据服务 API',
      version: '1.9.5',
      description: `由 DataBridge 自动生成的接口文档：共 ${apis.length} 个数据服务（${publishedCount} 个已发布）。运行时地址 /ds/{path}，鉴权走 X-API-Key 头（或 apiKey 查询参数）。tags 为绑定的数据源名，用于按数据源筛选；「文档中心」分组是自述——如何取本文档/登录/管理 docKey/查访问日志。`,
    },
    servers: [{ url: '/', description: '当前站点（管理端与运行时同源）' }],
    tags: tags.map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: '数据服务 API Key（发布时生成，也可用查询参数 apiKey 携带）',
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: '管理端登录令牌（POST /api/v1/auth/login），文档中心页面即为登录态',
        },
        DocKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-DOC-KEY',
          description: '个人文档 Key（契约 1.9.5，管理员开通后在文档中心页查看/刷新），仅用于取本文档',
        },
      },
    },
  };
};

module.exports = {
  OPENAPI_VERSION,
  buildSpec,
};
