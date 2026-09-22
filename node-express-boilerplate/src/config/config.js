const dotenv = require('dotenv');
const path = require('path');
const Joi = require('joi');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    PORT: Joi.number().default(3001),
    // DataBridge mock 阶段：MEM_MOCK=true 时完全不连数据库，只用内存仓储
    MEM_MOCK: Joi.string()
      .valid('true', 'false')
      .default('true')
      .description('run with in-memory repositories and skip MongoDB entirely'),
    // DataBridge 持久层驱动：memory = 纯内存 mock（默认），mysql = 真实落库
    DB_DRIVER: Joi.string()
      .valid('memory', 'mysql')
      .default('memory')
      .description('repository driver: memory (mock) | mysql'),
    MYSQL_HOST: Joi.string().allow('').default('').description('mysql host'),
    MYSQL_PORT: Joi.number().default(3306).description('mysql port'),
    MYSQL_USER: Joi.string().allow('').default('').description('mysql user'),
    MYSQL_PASSWORD: Joi.string().allow('').default('').description('mysql password'),
    MYSQL_DATABASE: Joi.string().allow('').default('dataLink').description('mysql schema'),
    MYSQL_CONNECTION_LIMIT: Joi.number().default(10).description('mysql pool size'),
    MYSQL_CONNECT_TIMEOUT_MS: Joi.number().default(10000).description('mysql connect timeout'),
    MONGODB_URL: Joi.string().allow('').default('').description('Mongo DB url (empty in memory-mock mode)'),
    JWT_SECRET: Joi.string().default('databridge-mock-secret').description('JWT secret key'),
    JWT_ACCESS_EXPIRATION_MINUTES: Joi.number().default(30).description('minutes after which access tokens expire'),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number().default(30).description('days after which refresh tokens expire'),
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description('minutes after which reset password token expires'),
    JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description('minutes after which verify email token expires'),
    // Go 同步引擎地址（POST /api/v1/engine/tasks/start|stop）
    ENGINE_BASE_URL: Joi.string().default('http://127.0.0.1:8080').description('base url of the Go sync engine'),
    // 引擎回报本服务的地址（POST /engine/report、/engine/logs），容器里写服务名
    ADMIN_REPORT_URL: Joi.string()
      .default('http://127.0.0.1:3001/api/v1/engine')
      .description('url the engine reports progress back to this admin service'),
    ENGINE_TIMEOUT_MS: Joi.number().default(5000).description('timeout of engine http calls'),
    SMTP_HOST: Joi.string().description('server that will send the emails'),
    SMTP_PORT: Joi.number().description('port to connect to the email server'),
    SMTP_USERNAME: Joi.string().description('username for email server'),
    SMTP_PASSWORD: Joi.string().description('password for email server'),
    EMAIL_FROM: Joi.string().description('the from field in the emails sent by the app'),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema.prefs({ errors: { label: 'key' } }).validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

module.exports = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  // DataBridge mock 开关：true 时 src/index.js 跳过 mongoose.connect，直接 listen
  // （兼容 docs/API.md 第 4 节里的别名 MOCK=true）
  memMock: envVars.MEM_MOCK === 'true' || process.env.MOCK === 'true',
  // 持久层驱动：memory（默认，纯内存 mock）| mysql（src/repositories/mysql 落库）
  db: {
    driver: envVars.DB_DRIVER || 'memory',
    isMysql: () => (envVars.DB_DRIVER || 'memory') === 'mysql',
    mysql: {
      host: envVars.MYSQL_HOST,
      port: envVars.MYSQL_PORT,
      user: envVars.MYSQL_USER,
      password: envVars.MYSQL_PASSWORD,
      database: envVars.MYSQL_DATABASE,
      connectionLimit: envVars.MYSQL_CONNECTION_LIMIT,
      connectTimeoutMs: envVars.MYSQL_CONNECT_TIMEOUT_MS,
    },
  },
  engine: {
    baseUrl: envVars.ENGINE_BASE_URL,
    reportUrl: envVars.ADMIN_REPORT_URL,
    timeoutMs: envVars.ENGINE_TIMEOUT_MS,
  },
  mongoose: {
    url: envVars.MONGODB_URL + (envVars.NODE_ENV === 'test' ? '-test' : ''),
    options: {
      useCreateIndex: true,
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  },
  jwt: {
    secret: envVars.JWT_SECRET,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes: envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes: envVars.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
  },
  email: {
    smtp: {
      host: envVars.SMTP_HOST,
      port: envVars.SMTP_PORT,
      auth: {
        user: envVars.SMTP_USERNAME,
        pass: envVars.SMTP_PASSWORD,
      },
    },
    from: envVars.EMAIL_FROM,
  },
};
